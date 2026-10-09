import { Router } from "express";
import { dbGet, dbAll, dbRun, withTransaction } from "../db";
import { isUsernameAllowed } from "../usernameFilter";
import { isTestName } from "../testAccount";
import { HouseState, parseHouse, cleanPlaced, cleanChest, houseToClient, FLOORS, WALLS, TIERS, MAX_OWNED_PER_ITEM, isFreeItem } from "../house";
import { HOUSE_ITEM_IDS } from "../houseCatalog";
import { inSameParty } from "../party";
import { parseTutorial, tutorialToClient, isTutId, isStepId, CHECKLIST_ITEMS } from "../tutorial";
import { EVENT_KINDS, cleanDetail } from "../events";
import { parseDiscovery, discoveryToClient, countWisp, tradeWisps } from "../discovery";
import {
  LorekinState, parseState as parseLorekin, toClient as lorekinToClient, pickSpecies, cleanName,
  DEFAULT_NAMES, incubateMs, BOOST_MS, MAX_COLLECTION, LorekinEntry, newEntry, addXp, xpNext, rarityOf, SPECIES_BY_RARITY,
} from "../lorekin";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { ah } from "../asyncHandler";

const router = Router();

// Milestone 175: shared by my-questions/question-attempts/my-class-progress/my-leaderboard
// below - all four used to each run their own "SELECT class_id FROM class_members WHERE
// student_id = ?" (correct back when a student could only ever have one row there); now that
// membership is many-to-many, they all need the ONE active class instead.
async function getActiveClassId(userId: number): Promise<number | null> {
  const user = await dbGet<{ active_class_id: number | null }>(
    "SELECT active_class_id FROM users WHERE id = ?",
    [userId]
  );
  return user?.active_class_id ?? null;
}

// requireAuth/requireRole are applied per-route (not via a blanket
// router.use()) because this router is mounted at the broad "/api" prefix
// alongside unrelated routes (register/login/character) defined directly
// on the main app - an unscoped router-level .use() here would intercept
// ALL /api/* traffic reaching this router before Express ever checks
// whether a specific route matches, which is exactly what happened the
// first time this was written: it 401'd plain registration too.

// Milestone 175: a student can now be in several classes at once - joining a new one ADDS a
// membership (ON CONFLICT DO NOTHING covers re-entering a code for a class already joined) and
// makes it the active one, rather than replacing whatever they were in before. See db.ts's
// users.active_class_id - that's what my-questions/question-attempts/my-class-progress/
// my-leaderboard below actually resolve against now.
router.post("/classes/join", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const { join_code } = req.body ?? {};
  if (typeof join_code !== "string" || join_code.trim().length === 0) {
    return res.status(400).json({ error: "Join code is required" });
  }

  const cls = await dbGet<{ id: number; name: string }>(
    "SELECT id, name FROM classes WHERE join_code = ?",
    [join_code.trim().toUpperCase()]
  );
  if (!cls) return res.status(404).json({ error: "No class with that code" });

  await dbRun(
    "INSERT INTO class_members (class_id, student_id) VALUES (?, ?) ON CONFLICT (class_id, student_id) DO NOTHING",
    [cls.id, req.userId!]
  );
  // Milestone 176: only auto-activate on the student's FIRST-ever class - joining a 2nd/3rd one
  // (e.g. just to have it on file) shouldn't silently yank them out of whatever class they're
  // actively working in. Use classes/active to switch on purpose.
  await dbRun("UPDATE users SET active_class_id = ? WHERE id = ? AND active_class_id IS NULL", [cls.id, req.userId!]);

  res.json({ class: cls });
}));

// Milestone 175: every class the student has joined, plus which one is active. Powers the
// class-enrollment NPC's swap menu - see obj_class_desk.
router.get("/classes/mine", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const classes = await dbAll<{ id: number; name: string }>(
    `SELECT c.id, c.name FROM class_members cm JOIN classes c ON c.id = cm.class_id
     WHERE cm.student_id = ? ORDER BY cm.joined_at ASC`,
    [req.userId!]
  );
  const activeClassId = await getActiveClassId(req.userId!);
  res.json({ classes, active_class_id: activeClassId });
}));

// Milestone 175: swap which already-joined class is active - doesn't touch membership, just
// which one my-questions/etc. resolve against from here on.
router.post("/classes/active", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.body?.class_id);
  if (!Number.isFinite(classId)) {
    return res.status(400).json({ error: "class_id is required" });
  }

  const member = await dbGet(
    "SELECT class_id FROM class_members WHERE class_id = ? AND student_id = ?",
    [classId, req.userId!]
  );
  if (!member) return res.status(404).json({ error: "You're not a member of that class" });

  await dbRun("UPDATE users SET active_class_id = ? WHERE id = ?", [classId, req.userId!]);
  res.json({ ok: true });
}));

// Milestone 175 (was body-less "/classes/leave", cleared every membership): leaves ONE specific
// class now. If that happened to be the active one, falls back to the next most-recently-joined
// remaining membership, or null (practice-questions mode) if that was the last one.
router.post("/classes/:id/leave", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  await dbRun("DELETE FROM class_members WHERE class_id = ? AND student_id = ?", [classId, req.userId!]);

  const activeClassId = await getActiveClassId(req.userId!);
  if (activeClassId === classId) {
    const next = await dbGet<{ class_id: number }>(
      "SELECT class_id FROM class_members WHERE student_id = ? ORDER BY joined_at DESC LIMIT 1",
      [req.userId!]
    );
    await dbRun("UPDATE users SET active_class_id = ? WHERE id = ?", [next?.class_id ?? null, req.userId!]);
  }

  res.json({ ok: true });
}));

// Aggregates every question from every question set assigned to the
// student's class into one flat pool, already shaped to match
// scr_questions.gml's struct fields so the client can use it as-is.
router.get("/my-questions", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const activeClassId = await getActiveClassId(req.userId!);

  if (!activeClassId) {
    return res.json({ questions: [] });
  }

  const rows = await dbAll<any>(
    `SELECT q.* FROM questions q
     JOIN class_assignments ca ON ca.question_set_id = q.question_set_id
     WHERE ca.class_id = ?`,
    [activeClassId]
  );

  const questions = rows.map((r) => ({
    id: String(r.id),
    question_type: r.question_type,
    prompt: r.prompt,
    answers: JSON.parse(r.answers_json),
    correct_index: r.correct_index,
    explanation: r.explanation ?? "",
    difficulty: r.difficulty,
    topic: r.topic ?? "",
    tags: JSON.parse(r.tags_json),
  }));

  res.json({ questions });
}));

// Fire-and-forget from the client's event bus (QUESTION_CORRECT /
// QUESTION_INCORRECT). class_id is looked up server-side rather than
// trusted from the client, and reflects whatever class the student is in
// *right now* - if they switch classes later, this attempt still counts
// against the class it was actually made in.
router.post("/question-attempts", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const { question_id, topic, correct, time_ms } = req.body ?? {};
  if (typeof correct !== "boolean") {
    return res.status(400).json({ error: "correct (boolean) is required" });
  }
  // how long the student took to answer (Milestone 274) - optional, clamped to a sane range
  const took = Number.isFinite(Number(time_ms)) && time_ms !== null ? Math.max(0, Math.min(600000, Math.round(Number(time_ms)))) : null;

  const activeClassId = await getActiveClassId(req.userId!);

  await dbRun(
    "INSERT INTO question_attempts (student_id, class_id, question_id, topic, correct, time_ms) VALUES (?, ?, ?, ?, ?, ?)",
    [req.userId!, activeClassId, question_id != null ? String(question_id) : null, topic ?? null, correct ? 1 : 0, took]
  );

  res.status(201).json({ ok: true });
}));

router.get("/my-accuracy", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const totals = await dbGet<{ attempts: number; correct_count: number }>(
    "SELECT COUNT(*)::int AS attempts, COALESCE(SUM(correct), 0)::int AS correct_count FROM question_attempts WHERE student_id = ?",
    [req.userId!]
  );

  const byTopic = await dbAll(
    `SELECT COALESCE(topic, '(none)') AS topic, COUNT(*)::int AS attempts, COALESCE(SUM(correct), 0)::int AS correct_count
     FROM question_attempts WHERE student_id = ? GROUP BY topic`,
    [req.userId!]
  );

  res.json({ attempts: totals!.attempts, correct: totals!.correct_count, by_topic: byTopic });
}));

// Milestone 11: Class Town; reworked (Milestone 269) from five fixed tiers into an endless tower. A single
// shared structure that gains one level for every CASTLE_LEVEL_STEP correct answers the whole class has racked up.
const CASTLE_LEVEL_STEP = 50;

router.get("/my-class-progress", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const activeClassId = await getActiveClassId(req.userId!);

  if (!activeClassId) {
    return res.json({ has_class: false });
  }

  const cls = await dbGet<{ name: string }>("SELECT name FROM classes WHERE id = ?", [activeClassId]);
  const row = await dbGet<{ total_correct: number; attempts: number }>(
    "SELECT COALESCE(SUM(correct), 0)::int AS total_correct, COUNT(*)::int AS attempts FROM question_attempts WHERE class_id = ?",
    [activeClassId]
  );
  const mem = await dbGet<{ n: number }>("SELECT COUNT(*)::int AS n FROM class_members WHERE class_id = ?", [activeClassId]);

  const level = Math.floor(row!.total_correct / CASTLE_LEVEL_STEP);

  res.json({
    has_class: true,
    class_name: cls!.name,
    total_correct: row!.total_correct,
    attempts: row!.attempts,
    members: mem?.n ?? 0,
    level,
    next_threshold: (level + 1) * CASTLE_LEVEL_STEP,
    // kept so older clients still read something sensible
    tier_index: Math.min(level, 4),
    tier_name: "Level " + level,
  });
}));

// Milestone 178: debug-only, mirrors the client's own debug_keys_enabled() gate (scr_player.gml
// - username "test", case-insensitive) so this can't just be called by any student even if they
// found the route - it inserts 50 correct question_attempts rows against whatever class is
// currently active, to test the class castle's tier thresholds without answering 50 real
// questions.
router.post("/debug/add-class-correct", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const user = await dbGet<{ username: string }>("SELECT username FROM users WHERE id = ?", [req.userId!]);
  if (!user || !isTestName(user.username)) {
    return res.status(403).json({ error: "Debug-only route" });
  }

  const activeClassId = await getActiveClassId(req.userId!);
  if (!activeClassId) {
    return res.status(400).json({ error: "Not in a class" });
  }

  const values: string[] = [];
  const params: any[] = [];
  for (let i = 0; i < 50; i++) {
    values.push("(?, ?, ?, ?, ?)");
    params.push(req.userId!, activeClassId, null, "debug", 1);
  }
  await dbRun(
    `INSERT INTO question_attempts (student_id, class_id, question_id, topic, correct) VALUES ${values.join(", ")}`,
    params
  );

  res.json({ ok: true });
}));

// Milestone 116: top 5 in the student's class, town leaderboard - ranked by level first, then
// accuracy (a level 10 at 95% outranks a level 8 at 99%, per direct spec). A student with zero
// attempts sorts as 0% rather than being excluded - still shows up if their level earns a spot.
router.get("/my-leaderboard", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const activeClassId = await getActiveClassId(req.userId!);

  if (!activeClassId) {
    return res.json({ has_class: false });
  }

  const cls = await dbGet<{ name: string }>("SELECT name FROM classes WHERE id = ?", [activeClassId]);

  const rows = await dbAll<{ username: string; level: number; attempts: number; correct_count: number }>(
    `SELECT u.username AS username, ch.level AS level,
       COALESCE(qa.attempts, 0)::int AS attempts,
       COALESCE(qa.correct_count, 0)::int AS correct_count
     FROM class_members cm
     JOIN users u ON u.id = cm.student_id
     JOIN characters ch ON ch.user_id = cm.student_id
     LEFT JOIN (
       SELECT student_id, COUNT(*)::int AS attempts, COALESCE(SUM(correct), 0)::int AS correct_count
       FROM question_attempts GROUP BY student_id
     ) qa ON qa.student_id = cm.student_id
     WHERE cm.class_id = ?
     ORDER BY ch.level DESC,
       CASE WHEN COALESCE(qa.attempts, 0) = 0 THEN 0 ELSE COALESCE(qa.correct_count, 0)::float / qa.attempts END DESC
     LIMIT 5`,
    [activeClassId]
  );

  const leaderboard = rows.map((r) => ({
    username: r.username,
    level: r.level,
    accuracy_pct: r.attempts > 0 ? Math.round((r.correct_count / r.attempts) * 100) : 0,
  }));

  res.json({ has_class: true, class_name: cls!.name, leaderboard });
}));

// Milestone 255: the Endless Dungeon. The game calls /endless/start when a run begins (resets the
// run's counter) and /endless/complete once per dungeon beaten; the server does the counting
// rather than trusting a client-sent total, and refuses completions closer together than
// MIN_ENDLESS_GAP_S (a real dungeon - ~10 rooms, a boss - can't be cleared faster), so the number
// can't be inflated by simply POSTing a big value or hammering the route. A determined student can
// still fake completions slowly (same trust level as the rest of the client-saved game), but not
// cheaply or instantly.
const MIN_ENDLESS_GAP_S = 90;

router.post("/endless/start", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  await dbRun("UPDATE users SET endless_current = 0 WHERE id = ?", [req.userId!]);
  res.json({ ok: true });
}));

router.post("/endless/complete", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const row = await dbGet<{ endless_current: number; endless_best: number; secs: number | null }>(
    `SELECT endless_current, endless_best,
       EXTRACT(EPOCH FROM (now() - endless_last_complete))::float AS secs
     FROM users WHERE id = ?`,
    [req.userId!]
  );
  if (!row) return res.status(404).json({ error: "No such account" });
  if (row.secs != null && row.secs < MIN_ENDLESS_GAP_S) {
    return res.json({ ok: false, reason: "too_fast", streak: row.endless_current, best: row.endless_best });
  }
  const streak = row.endless_current + 1;
  const best = Math.max(row.endless_best, streak);
  await dbRun(
    "UPDATE users SET endless_current = ?, endless_best = ?, endless_last_complete = now() WHERE id = ?",
    [streak, best, req.userId!]
  );
  res.json({ ok: true, streak, best });
}));

// Class-scoped, like /my-leaderboard: the active class's top 5 by best run, only students who've
// completed at least one endless dungeon. Plus the caller's own best, so the panel can show it
// even when they're outside the top 5.
router.get("/my-endless-leaderboard", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const activeClassId = await getActiveClassId(req.userId!);
  const me = await dbGet<{ endless_best: number }>("SELECT endless_best FROM users WHERE id = ?", [req.userId!]);
  if (!activeClassId) {
    return res.json({ has_class: false, my_best: me?.endless_best ?? 0 });
  }
  const cls = await dbGet<{ name: string }>("SELECT name FROM classes WHERE id = ?", [activeClassId]);
  const rows = await dbAll<{ username: string; endless_best: number }>(
    `SELECT u.username AS username, u.endless_best AS endless_best
     FROM class_members cm
     JOIN users u ON u.id = cm.student_id
     WHERE cm.class_id = ? AND u.endless_best > 0
     ORDER BY u.endless_best DESC, u.username ASC
     LIMIT 5`,
    [activeClassId]
  );
  res.json({
    has_class: true,
    class_name: cls!.name,
    my_best: me?.endless_best ?? 0,
    leaderboard: rows.map((r) => ({ username: r.username, best: r.endless_best })),
  });
}));

// Milestone 256: Lorekin (pets). Everything goes through lorekinMutate: it locks the character
// row, lets the handler change the parsed state (or return an error string without saving), and
// writes it back - so two quick requests (a double-clicked button, or two devices) can never both
// act on the same stale copy. The client only ever receives lorekinToClient()'s view of the state,
// with the incubator as "seconds left".
async function lorekinMutate(
  userId: number,
  fn: (st: LorekinState) => string | void
): Promise<{ error?: string; state: ReturnType<typeof lorekinToClient> }> {
  return withTransaction(async (query) => {
    const r = await query("SELECT lorekin_json FROM characters WHERE user_id = ? FOR UPDATE", [userId]);
    const st = parseLorekin(r.rows[0]?.lorekin_json);
    const err = fn(st);
    if (err) return { error: err, state: lorekinToClient(st) };
    await query("UPDATE characters SET lorekin_json = ? WHERE user_id = ?", [JSON.stringify(st), userId]);
    return { state: lorekinToClient(st) };
  });
}

router.get("/lorekin", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const r = await dbGet<{ lorekin_json: string }>("SELECT lorekin_json FROM characters WHERE user_id = ?", [req.userId!]);
  res.json({ lorekin: lorekinToClient(parseLorekin(r?.lorekin_json)) });
}));

router.post("/lorekin/incubate", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const rarity = Number(req.body?.rarity);
  if (!Number.isInteger(rarity) || rarity < 0 || rarity > 3) return res.json({ ok: false, error: "Bad egg rarity" });
  const out = await lorekinMutate(req.userId!, (st) => {
    if (st.incubator) return "Something is already incubating";
    if (st.list.length >= MAX_COLLECTION) return "Your Lorekin collection is full";
    // Milestone 318: an egg of a named species - accepted only if that species really is of this egg's rarity
    const species = typeof req.body?.species === "string" && SPECIES_BY_RARITY[rarity]?.includes(req.body.species) ? req.body.species : undefined;
    st.incubator = { rarity, ready_at: Date.now() + incubateMs(rarity), ...(species ? { species } : {}) };
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, lorekin: out.state });
}));

// One Knowledge Crystal charge (spent by the client AFTER this succeeds) takes BOOST_MS off the wait.
router.post("/lorekin/boost", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const out = await lorekinMutate(req.userId!, (st) => {
    if (!st.incubator) return "Nothing is incubating";
    if (st.incubator.ready_at <= Date.now()) return "Already ready to hatch";
    st.incubator.ready_at -= BOOST_MS;
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, lorekin: out.state });
}));

router.post("/lorekin/hatch", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  let hatched: LorekinEntry | null = null;
  const out = await lorekinMutate(req.userId!, (st) => {
    if (!st.incubator) return "Nothing is incubating";
    if (st.incubator.ready_at > Date.now()) return "Not ready yet";
    if (st.list.length >= MAX_COLLECTION) return "Your Lorekin collection is full";
    const named = st.incubator.species && SPECIES_BY_RARITY[st.incubator.rarity]?.includes(st.incubator.species) ? st.incubator.species : null;
    const species = named ?? pickSpecies(st.incubator.rarity);
    hatched = newEntry(st.next_id, species);
    st.next_id += 1;
    st.list.push(hatched);
    if (st.active == null) st.active = hatched.id; // the first one hatched starts out as your companion
    st.incubator = null;
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, hatched, lorekin: out.state });
}));

// Milestone 294: combat XP for a Lorekin. The game batches what its ACTIVE Lorekin earned from kills and sends it here every so often;
// the server runs the level curve (xpNext) and answers with the new state. A single call is capped (a stale or hacked client can't
// dump an unlimited amount in one go).
router.post("/lorekin/xp", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const id = Number(req.body?.id);
  const amount = Math.floor(Number(req.body?.xp));
  if (!Number.isInteger(id) || !Number.isFinite(amount) || amount <= 0) return res.json({ ok: false, error: "Bad XP" });
  const out = await lorekinMutate(req.userId!, (st) => {
    const e = st.list.find((x) => x.id === id);
    if (!e) return "No such Lorekin";
    const cap = 20 * xpNext(e.level, rarityOf(e.species));
    addXp(e, Math.min(amount, cap));
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, lorekin: out.state });
}));

router.post("/lorekin/rename", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const id = Number(req.body?.id);
  const name = cleanName(req.body?.name);
  if (!name) return res.json({ ok: false, error: "Names are 1-14 letters, numbers, spaces, - or '" });
  if (!isUsernameAllowed(name)) return res.json({ ok: false, error: "That name isn't allowed" });
  const out = await lorekinMutate(req.userId!, (st) => {
    const e = st.list.find((x) => x.id === id);
    if (!e) return "No such Lorekin";
    e.name = name;
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, lorekin: out.state });
}));

// Releasing a Lorekin deletes it from the collection for good. The game asks "are you sure?" first; if it
// was the active one, nothing is out afterwards. (An egg already incubating is unaffected.)
router.post("/lorekin/release", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const id = Number(req.body?.id);
  const out = await lorekinMutate(req.userId!, (st) => {
    const i = st.list.findIndex((x) => x.id === id);
    if (i < 0) return "No such Lorekin";
    st.list.splice(i, 1);
    if (st.active === id) st.active = null;
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, lorekin: out.state });
}));

router.post("/lorekin/active", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const raw = req.body?.id;
  const id = raw == null ? null : Number(raw);
  const out = await lorekinMutate(req.userId!, (st) => {
    if (id != null && !st.list.some((x) => x.id === id)) return "No such Lorekin";
    st.active = id;
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, lorekin: out.state });
}));

// Testing aid: the account named "test" (the same one the game's debug keys are limited to) can finish
// its incubator instantly, since waiting 24 real hours to test a hatch is no use to anyone.
router.post("/lorekin/debug_ready", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const u = await dbGet<{ username: string }>("SELECT username FROM users WHERE id = ?", [req.userId!]);
  if (!u || !isTestName(u.username)) return res.json({ ok: false, error: "Not available" });
  const out = await lorekinMutate(req.userId!, (st) => {
    if (!st.incubator) return "Nothing is incubating";
    st.incubator.ready_at = Date.now() - 1000;
  });
  if (out.error) return res.json({ ok: false, error: out.error, lorekin: out.state });
  res.json({ ok: true, lorekin: out.state });
}));

// Milestone 307: the game's event log. The game queues events and sends them in batches (about once a minute and on logout):
// { events: [{ k: "death", d: "dungeon:desert", n: 1 }, ...] }. Anything not on the allowlist is dropped, so a client can never fill the
// table with junk; at most 60 events per request.
router.post("/events", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 60) : [];
  let saved = 0;
  for (const e of list) {
    const kind = typeof e?.k === "string" ? e.k : "";
    if (!EVENT_KINDS.includes(kind)) continue;
    const n = Number.isFinite(Number(e?.n)) ? Math.max(1, Math.min(1000000, Math.round(Number(e.n)))) : 1;
    await dbRun("INSERT INTO game_events (user_id, kind, detail, n) VALUES (?, ?, ?, ?)", [req.userId!, kind, cleanDetail(e?.d), n]);
    saved++;
  }
  res.json({ ok: true, saved });
}));

// Milestone 311: a Memory Wisp was collected - it is carried until traded in. The server keeps the counts and paces them.
router.post("/discovery/wisp", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const out = await withTransaction(async (query) => {
    const r = await query("SELECT discovery_json FROM characters WHERE user_id = ? FOR UPDATE", [req.userId!]);
    const st = parseDiscovery(r.rows[0]?.discovery_json);
    const c = countWisp(st, Date.now());
    if (c.ok) await query("UPDATE characters SET discovery_json = ? WHERE user_id = ?", [JSON.stringify(st), req.userId!]);
    return { ...c, discovery: discoveryToClient(st) };
  });
  res.json(out);
}));

// Milestone 312: the Wisp Keeper buys every carried wisp (a flat price each). The game adds the gold from this answer.
router.post("/discovery/exchange", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const out = await withTransaction(async (query) => {
    const r = await query("SELECT discovery_json FROM characters WHERE user_id = ? FOR UPDATE", [req.userId!]);
    const st = parseDiscovery(r.rows[0]?.discovery_json);
    const t = tradeWisps(st);
    if (t.n > 0) await query("UPDATE characters SET discovery_json = ? WHERE user_id = ?", [JSON.stringify(st), req.userId!]);
    return { ok: true, n: t.n, gold: t.gold, discovery: discoveryToClient(st) };
  });
  res.json(out);
}));

// Milestone 297: tutorial progress (tutorial.ts). The game reports each step the player reaches and when a tutorial ends; "done" answers
// first:true exactly once per tutorial (the game hands out the finish reward only then, so a replay never pays twice).
router.post("/tutorial/step", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const tut = req.body?.tut;
  const step = req.body?.step;
  if (!isTutId(tut) || !isStepId(step)) return res.json({ ok: false, error: "Bad step" });
  await withTransaction(async (query) => {
    const r = await query("SELECT tutorial_json FROM characters WHERE user_id = ? FOR UPDATE", [req.userId!]);
    const st = parseTutorial(r.rows[0]?.tutorial_json);
    if (st.step[tut] === step) return; // already there (a resume, or a repeat report)
    st.step[tut] = step;
    await query("UPDATE characters SET tutorial_json = ? WHERE user_id = ?", [JSON.stringify(st), req.userId!]);
    await query("INSERT INTO tutorial_events (user_id, tut, step, kind) VALUES (?, ?, ?, 'step')", [req.userId!, tut, step]);
  });
  res.json({ ok: true });
}));

// Milestone 299: tick one item of a checklist tutorial ("checklist" -> class, quest, home...). Idempotent.
router.post("/tutorial/tick", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const tut = req.body?.tut;
  const item = req.body?.item;
  if (tut !== "checklist" || !CHECKLIST_ITEMS.includes(item)) return res.json({ ok: false, error: "Bad item" });
  const out = await withTransaction(async (query) => {
    const r = await query("SELECT tutorial_json FROM characters WHERE user_id = ? FOR UPDATE", [req.userId!]);
    const st = parseTutorial(r.rows[0]?.tutorial_json);
    const list = st.ticks[tut] ?? [];
    if (!list.includes(item)) {
      list.push(item);
      st.ticks[tut] = list;
      await query("UPDATE characters SET tutorial_json = ? WHERE user_id = ?", [JSON.stringify(st), req.userId!]);
      await query("INSERT INTO tutorial_events (user_id, tut, step, kind) VALUES (?, ?, ?, 'tick')", [req.userId!, tut, item]);
    }
    return tutorialToClient(st);
  });
  res.json({ ok: true, tutorial: out });
}));

// Test account only: wipe every tutorial record so the whole thing can be tried again.
router.post("/tutorial/debug_reset", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const who = await dbGet<{ username: string }>("SELECT username FROM users WHERE id = ?", [req.userId!]);
  if (!who || !isTestName(who.username)) return res.json({ ok: false, error: "Test account only" });
  await dbRun("UPDATE characters SET tutorial_json = '{}' WHERE user_id = ?", [req.userId!]);
  res.json({ ok: true, tutorial: tutorialToClient(parseTutorial("{}")) });
}));

router.post("/tutorial/done", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const tut = req.body?.tut;
  const skipped = !!req.body?.skipped;
  if (!isTutId(tut)) return res.json({ ok: false, error: "Bad tutorial" });
  const out = await withTransaction(async (query) => {
    const r = await query("SELECT tutorial_json FROM characters WHERE user_id = ? FOR UPDATE", [req.userId!]);
    const st = parseTutorial(r.rows[0]?.tutorial_json);
    // the checklist only finishes when every item is ticked
    if (tut === "checklist" && !CHECKLIST_ITEMS.every((i) => (st.ticks["checklist"] ?? []).includes(i))) {
      return { first: false, tutorial: tutorialToClient(st) };
    }
    const first = !st.done[tut];
    if (first) {
      st.done[tut] = Date.now();
      if (skipped) st.skipped[tut] = true;
      delete st.step[tut];
      await query("UPDATE characters SET tutorial_json = ? WHERE user_id = ?", [JSON.stringify(st), req.userId!]);
      await query("INSERT INTO tutorial_events (user_id, tut, step, kind) VALUES (?, ?, ?, ?)", [req.userId!, tut, "end", skipped ? "skip" : "done"]);
    }
    return { first, tutorial: tutorialToClient(st) };
  });
  res.json({ ok: true, first: out.first, skipped: skipped, tutorial: out.tutorial });
}));

router.get("/tutorial", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const r = await dbGet<{ tutorial_json: string | null }>("SELECT tutorial_json FROM characters WHERE user_id = ?", [req.userId!]);
  res.json({ tutorial: tutorialToClient(parseTutorial(r?.tutorial_json)) });
}));

// Milestone 262: the player home. Same locked read-modify-write as the Lorekin routes; logic errors come
// back as HTTP 200 { ok: false, error } (GX.games hides the body of a non-2xx response).
async function houseMutate(
  userId: number,
  fn: (st: HouseState) => string | void
): Promise<{ error?: string; state: ReturnType<typeof houseToClient> }> {
  return withTransaction(async (query) => {
    const r = await query("SELECT c.house_json, u.username FROM characters c JOIN users u ON u.id = c.user_id WHERE c.user_id = ? FOR UPDATE OF c", [userId]);
    const isTest = isTestName(r.rows[0]?.username);
    const { state } = parseHouse(r.rows[0]?.house_json, isTest);
    const err = fn(state);
    if (err) return { error: err, state: houseToClient(state) };
    await query("UPDATE characters SET house_json = ? WHERE user_id = ?", [JSON.stringify(state), userId]);
    return { state: houseToClient(state) };
  });
}

router.get("/house", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const out = await houseMutate(req.userId!, () => {});
  res.json({ house: out.state });
}));

// The whole layout in one go (the editor saves when you press Done): { placed: [{ item, x, y, flip }] }.
router.post("/house/save", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const out = await houseMutate(req.userId!, (st) => {
    const cleaned = cleanPlaced(st, req.body?.placed);
    if (typeof cleaned === "string") return cleaned;
    if (req.body?.chest != null) {
      const c = cleanChest(st, req.body.chest);
      if (typeof c === "string") return c;
      st.chest = c;
    }
    st.placed = cleaned;
  });
  if (out.error) return res.json({ ok: false, error: out.error, house: out.state });
  res.json({ ok: true, house: out.state });
}));

// Records a purchase from the Carpenter: +1 of an item. The game checks and spends the gold itself (gold is
// client-side, like the shop), calling this FIRST and spending only if it succeeds.
router.post("/house/buy", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const item = String(req.body?.item ?? "");
  const out = await houseMutate(req.userId!, (st) => {
    if (!HOUSE_ITEM_IDS.includes(item)) return "Unknown furniture";
    if (isFreeItem(item)) return "Walls are free - just place them";
    if ((st.owned[item] ?? 0) >= MAX_OWNED_PER_ITEM) return "You already own plenty of those";
    st.owned[item] = (st.owned[item] ?? 0) + 1;
  });
  if (out.error) return res.json({ ok: false, error: out.error, house: out.state });
  res.json({ ok: true, house: out.state });
}));

router.post("/house/wall", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const wall = String(req.body?.wall ?? "");
  const out = await houseMutate(req.userId!, (st) => {
    if (!WALLS.includes(wall)) return "Unknown wall";
    st.wall = wall;
  });
  if (out.error) return res.json({ ok: false, error: out.error, house: out.state });
  res.json({ ok: true, house: out.state });
}));

// One size bigger (Cottage -> House -> Manor). The game checks and spends the gold itself, calling this FIRST.
router.post("/house/upgrade", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const out = await houseMutate(req.userId!, (st) => {
    if (st.tier >= TIERS.length - 1) return "Your home is already the biggest it can be";
    st.tier += 1;
  });
  if (out.error) return res.json({ ok: false, error: out.error, house: out.state });
  res.json({ ok: true, house: out.state });
}));

// Testing aid ("test" account only): cycle the home size Cottage -> House -> Manor -> Cottage. Going DOWN keeps
// only the pieces that still fit (inside the smaller room, within its piece cap) - nothing owned is lost.
router.post("/house/debug_tier", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const u = await dbGet<{ username: string }>("SELECT username FROM users WHERE id = ?", [req.userId!]);
  if (!u || !isTestName(u.username)) return res.json({ ok: false, error: "Not available" });
  const out = await houseMutate(req.userId!, (st) => {
    st.tier = (st.tier + 1) % TIERS.length;
    const t = TIERS[st.tier];
    const fits = st.placed.filter((p) => p.x >= 20 && p.x <= t.w - 20 && p.y >= 60 && p.y <= t.h - 20);
    let kept = 0;
    st.placed = fits.filter((p) => isFreeItem(p.item) || ++kept <= t.max); // partitions don't use the piece cap
    if (st.chest.x > t.w - 20 || st.chest.y > t.h - 20) st.chest = { x: Math.min(st.chest.x, t.w - 70), y: Math.min(st.chest.y, 150) };
  });
  if (out.error) return res.json({ ok: false, error: out.error, house: out.state });
  res.json({ ok: true, house: out.state });
}));

// ---- visiting (Milestone 268) ----
// A home may be visited by its owner, by anyone who shares a class with them, or by anyone in the same live
// party (the host shows the party around). Visitors only ever READ - there is no route that lets anyone but
// the owner change a house.
async function houseAccess(me: number, owner: number): Promise<boolean> {
  if (me === owner) return true;
  return inSameParty(me, owner);
}

// Another player's home plus the numbers its Trophy Board shows.
router.get("/house/of/:username", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const owner = await dbGet<{ id: number; username: string; endless_best: number }>(
    "SELECT id, username, endless_best FROM users WHERE LOWER(username) = LOWER(?) AND role = 'student'",
    [String(req.params.username ?? "")]
  );
  if (!owner) return res.json({ ok: false, error: "No such player" });
  if (!(await houseAccess(req.userId!, owner.id))) return res.json({ ok: false, error: "You can only see the homes of players in your party" });
  const c = await dbGet<{ house_json: string; level: number; inventory_json: string; lorekin_json: string; discovery_json: string }>(
    "SELECT house_json, level, inventory_json, lorekin_json, discovery_json FROM characters WHERE user_id = ?",
    [owner.id]
  );
  if (!c) return res.json({ ok: false, error: "No such player" });
  const state = parseHouse(c.house_json, isTestName(owner.username)).state;
  let bossKills: Record<string, number> = {};
  let tier = 0;
  // Milestone 332: lifetime tallies the game keeps on the Conqueror's Badge (monsters, gold earned, quests, towers, champions)
  const tally: Record<string, number> = { kills: 0, gold: 0, quests: 0, towers: 0, champions: 0 };
  try {
    const inv = JSON.parse(c.inventory_json);
    const badge = Array.isArray(inv) ? inv.find((i: any) => i && i.badge) : undefined;
    if (badge) {
      bossKills = badge.boss_kills && typeof badge.boss_kills === "object" ? badge.boss_kills : {};
      tier = Number.isInteger(badge.max_unlocked_tier) ? badge.max_unlocked_tier : 0;
      if (badge.tally && typeof badge.tally === "object") for (const k of Object.keys(tally)) tally[k] = Math.max(0, Math.floor(Number(badge.tally[k]) || 0));
    }
  } catch { /* leave the defaults */ }
  const att = await dbGet<{ n: number; ok: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(correct), 0) AS ok FROM question_attempts WHERE student_id = ?", [owner.id]);
  const wisps = parseDiscovery(c.discovery_json).lifetime;
  let lorekinCount = 0;
  try { lorekinCount = (JSON.parse(c.lorekin_json).list ?? []).length; } catch { /* 0 */ }
  res.json({
    ok: true,
    owner: owner.username,
    house: houseToClient(state),
    stats: {
      level: c.level, tier, boss_kills: bossKills, endless_best: owner.endless_best ?? 0, lorekin: lorekinCount,
      questions: Number(att?.n ?? 0), questions_correct: Number(att?.ok ?? 0), wisps, tally,
    },
  });
}));

router.post("/house/floor", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const floor = String(req.body?.floor ?? "");
  const out = await houseMutate(req.userId!, (st) => {
    if (!FLOORS.includes(floor)) return "Unknown floor";
    st.floor = floor;
  });
  if (out.error) return res.json({ ok: false, error: out.error, house: out.state });
  res.json({ ok: true, house: out.state });
}));

export default router;
