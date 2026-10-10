import { Pool, PoolClient } from "pg";

// Postgres, swapped in from node:sqlite for the Render deploy - see
// server/README.md. Render's web services have EPHEMERAL disk: a SQLite
// file there gets wiped on every redeploy AND every free-tier spin-down/
// spin-up cycle, which isn't a "when convenient" upgrade, it's a hard
// blocker for real persistence. DATABASE_URL is provided automatically by
// Render when a Postgres instance is linked to this service (see
// render.yaml); for local dev, point it at any Postgres you have running.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required - see server/.env.example");
}

export const pool = new Pool({
  connectionString,
  // Render's Postgres needs SSL for connections outside its own private
  // network (e.g. this service's public/external URL, or a local dev
  // machine); its internal URL also accepts this happily. Set
  // DATABASE_SSL=false only for a local Postgres with no cert at all.
  ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false },
});

// SQLite used `?` positional placeholders everywhere (40+ call sites across
// the route files); Postgres needs `$1, $2, ...`. Converting every call site
// by hand risked mis-numbered placeholders on a rewrite this size, so this
// rewrites the `?`s instead - callers keep writing SQL the way they already
// were.
function toPgQuery(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function dbGet<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows[0] as T | undefined;
}

export async function dbAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows as T[];
}

export async function dbRun(sql: string, params: any[] = []): Promise<{ rowCount: number }> {
  const res = await pool.query(toPgQuery(sql), params);
  return { rowCount: res.rowCount ?? 0 };
}

// For an INSERT that needs the new row's id back (SQLite's lastInsertRowid).
// `sql` must not already end with a semicolon.
export async function dbInsertId(sql: string, params: any[] = []): Promise<number> {
  const res = await pool.query(`${toPgQuery(sql)} RETURNING id`, params);
  return res.rows[0].id;
}

// The CSV import's batch insert is the only multi-statement transaction in
// this codebase - BEGIN/COMMIT/ROLLBACK need to run on the SAME connection,
// which a bare `pool.query()` doesn't guarantee (the pool can hand out a
// different client per call), so this pins one client for the duration.
export async function withTransaction<T>(
  fn: (query: (sql: string, params?: any[]) => Promise<any>) => Promise<T>
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((sql, params = []) => client.query(toPgQuery(sql), params));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS characters (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      xp_to_level INTEGER NOT NULL DEFAULT 50,
      base_max_hp INTEGER NOT NULL DEFAULT 100,
      base_atk_damage INTEGER NOT NULL DEFAULT 12,
      inventory_json TEXT NOT NULL DEFAULT '[]',
      equipped_weapon_json TEXT,
      equipped_helmet_json TEXT,
      equipped_chest_json TEXT,
      equipped_accessory_json TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS dungeon_runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      dungeon_name TEXT NOT NULL,
      xp_gained INTEGER NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      join_code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS class_members (
      class_id INTEGER NOT NULL REFERENCES classes(id),
      student_id INTEGER NOT NULL REFERENCES users(id),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (class_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS question_sets (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      subject TEXT,
      grade TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
      question_type TEXT NOT NULL DEFAULT 'mc',
      prompt TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      correct_index INTEGER NOT NULL,
      explanation TEXT,
      difficulty INTEGER NOT NULL DEFAULT 1,
      topic TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS class_assignments (
      class_id INTEGER NOT NULL REFERENCES classes(id),
      question_set_id INTEGER NOT NULL REFERENCES question_sets(id),
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (class_id, question_set_id)
    );

    CREATE TABLE IF NOT EXISTS question_attempts (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id),
      class_id INTEGER,
      question_id TEXT,
      topic TEXT,
      correct INTEGER NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // SQLite needed a hand-rolled PRAGMA table_info check for this column
  // (added in Milestone 6, after some databases already existed without
  // it) since its CREATE TABLE IF NOT EXISTS only applies to a fresh table.
  // Postgres's ADD COLUMN IF NOT EXISTS does the same job in one line.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student'");
  // Milestone 171: a single designated admin account ("admin", formerly "tester") that can reset ANY account's
  // password (student or teacher, any class or none) - bypasses the per-teacher class-ownership
  // scoping everything else in routes/teacher.ts enforces. Re-applied on every boot (not just at
  // table-creation time) so it's self-healing if that account ever gets dropped and re-registered.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false");
  // Milestone 273: the accounts were renamed - the developer/test account "test" is now "MrLooms" and the admin teacher
  // "tester" is now "admin". Done once, here, if the old name exists and the new one is free (never overwrites an
  // account). The server's test-account checks accept both names (testAccount.ts).
  for (const [from, to] of [["test", "MrLooms"], ["tester", "admin"]]) {
    const old = await pool.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [from]);
    if (old.rows.length === 0) continue;
    const taken = await pool.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", [to]);
    if (taken.rows.length > 0) { console.warn("[db] not renaming " + from + " -> " + to + ": that name is already taken"); continue; }
    await pool.query("UPDATE users SET username = $1 WHERE id = $2", [to, old.rows[0].id]);
    console.log("[db] renamed account " + from + " -> " + to);
  }
  await pool.query("UPDATE users SET is_admin = true WHERE LOWER(username) = 'admin' AND role = 'teacher'");
  // Milestone 274: playtime / session tracking and how long each question took (see activity.ts)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS play_sessions (
      sid TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      active_seconds INTEGER NOT NULL DEFAULT 0,
      build TEXT
    );
    CREATE INDEX IF NOT EXISTS play_sessions_user ON play_sessions(user_id, last_seen);
    CREATE TABLE IF NOT EXISTS play_activity (
      user_id INTEGER NOT NULL REFERENCES users(id),
      day DATE NOT NULL DEFAULT CURRENT_DATE,
      area TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, area)
    );
  `);
  await pool.query("ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS time_ms INTEGER");
  // Milestone 173: teacher password recovery - null for every existing account (including old
  // teacher accounts registered before this existed), required only for NEW teacher registrations
  // going forward. A student account never has one - the "forgot password" flow is teacher-only,
  // students go through their teacher (see M100/M171's teacher-initiated resets) since typing an
  // email at signup isn't realistic for a grades 5-9 classroom account.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT");
  // Milestone 175: multi-class membership - class_members' own PK (class_id, student_id) already
  // permitted more than one row per student (nothing enforced single-class at the DB layer), the
  // MVP-era single-class assumption was only in the route logic (join deleted every existing
  // membership first). This tracks which ONE of a student's several joined classes is "active"
  // right now - the one my-questions/question-attempts/my-class-progress/my-leaderboard actually
  // use. NULL until they've ever joined a class.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS active_class_id INTEGER REFERENCES classes(id)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Milestone 108: the personal storage chest - same "existing databases don't get new
  // columns from CREATE TABLE IF NOT EXISTS" reasoning as role above.
  await pool.query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS storage_json TEXT NOT NULL DEFAULT '[]'");
  // Milestone 166: last known overworld cell, for resuming there on next login instead of
  // always dropping back in town - see project_warpstone design conversation.
  // Milestone 255: the Endless Dungeon leaderboard. `endless_current` is the run in progress
  // (reset by /endless/start, +1 per /endless/complete), `endless_best` the best any run has
  // reached, `endless_last_complete` rate-limits completions (see routes/student.ts). Per USER, not
  // per class - the class-scoped leaderboard just reads these for its members.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS endless_current INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS endless_best INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS endless_last_complete TIMESTAMPTZ");
  // Milestone 256: Lorekin (pets) - collection, active one and egg incubator, as one opaque JSON
  // blob (see lorekin.ts). Changed only through the /api/lorekin/* routes, never the character PUT.
  await pool.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS lorekin_json TEXT NOT NULL DEFAULT '{"list":[],"active":null,"next_id":1,"incubator":null}'`);
  // Milestone 262: the player home - owned furniture, placed layout, floor style, tier (see house.ts). Changed only
  // through the /api/house/* routes, never the character PUT.
  await pool.query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS house_json TEXT NOT NULL DEFAULT '{}'");
  // Milestone 297: tutorial progress (see tutorial.ts). Every character that exists WHEN THIS COLUMN IS FIRST ADDED already knows the
  // game, so they are marked as having finished Basic Training; accounts made afterwards start with NULL and get the training. The
  // check on information_schema keeps this from running again (and grandfathering brand-new accounts) on every later boot.
  const tcol = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'characters' AND column_name = 'tutorial_json'");
  if (tcol.rows.length === 0) {
    await pool.query("ALTER TABLE characters ADD COLUMN tutorial_json TEXT");
    await pool.query(`UPDATE characters SET tutorial_json = '{"done":{"basic":1},"skipped":{},"step":{}}'`); // done time 1 = "already playing before tutorials existed"
  }
  // Milestone 347: seasonal events (the Halloween event) - one row per student per event, an opaque JSON blob (candy, the day's counters, claims) - see seasonal.ts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS season_state (
      user_id INTEGER NOT NULL REFERENCES users(id),
      event_id TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (user_id, event_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tutorial_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      tut TEXT NOT NULL,
      step TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tutorial_events_tut ON tutorial_events(tut, kind, step);
  `);
  // Milestone 307: the game event log (deaths, level-ups, dungeon entries, feature use, gold...) - see events.ts. Plain append-only rows,
  // written in batches by the game; the teacher dashboard sums them per class.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      n INTEGER NOT NULL DEFAULT 1,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS game_events_user ON game_events(user_id, at);
    CREATE INDEX IF NOT EXISTS game_events_kind ON game_events(kind, at);
  `);
  // where the session was when the last heartbeat arrived - "where do students stop playing"
  await pool.query("ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS last_place TEXT");
  // Milestone 311: overworld discovery progress (wisps found, milestones paid) - see discovery.ts
  await pool.query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS discovery_json TEXT NOT NULL DEFAULT '{}'");
  await pool.query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS world_x INTEGER");
  // Milestone 345: the cosmetics (LPC accessories) this account owns - a JSON array of cosmetic ids. What is WORN lives in appearance_json (appearance.cos).
  // Nothing grants them yet (no shop / event claims); the test accounts own everything client-side.
  await pool.query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS cosmetics_json TEXT NOT NULL DEFAULT '[]'");
  await pool.query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS world_y INTEGER");
  // Milestone 185: LPC character customization (phase 2) - which variant of each layer
  // (skin/hair/torso/legs/feet) this character draws. Same opaque-JSON-blob pattern as
  // storage_json above. Default matches the phase-1 default combo so existing characters
  // look unchanged until they visit the wardrobe keeper.
  await pool.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS appearance_json TEXT NOT NULL DEFAULT '{"skin":"light","hair":"plain_auburn","torso":"leather","legs":"pants","feet":"boots"}'`);
  // Milestone 190: hair_color didn't exist when appearance_json was first added above - an
  // already-migrated row's JSON blob simply lacks the key (the GML client backfills it on
  // load, same pattern as every other appearance back-compat case). Nothing to migrate here.
}
