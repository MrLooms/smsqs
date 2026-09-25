import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import path from "path";
import { initDb, dbGet, dbInsertId, dbRun } from "./db";
import { generateToken, requireAuth, AuthedRequest } from "./auth";
import { ah } from "./asyncHandler";
import { CharacterState, DEFAULT_CHARACTER, Item } from "./types";
import { isUsernameAllowed } from "./usernameFilter";
import teacherRouter from "./routes/teacher";
import studentRouter from "./routes/student";
import { attachMultiplayer } from "./ws";

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));

// Render's health check (and just a quick way to confirm the service and
// its DB connection are both up) - unauthenticated on purpose.
app.get("/healthz", ah(async (_req, res) => {
  await dbGet("SELECT 1");
  res.json({ ok: true });
}));

app.use("/api/teacher", teacherRouter);
app.use("/api", studentRouter);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

function parseItem(json: string | null): Item | null {
  return json ? (JSON.parse(json) as Item) : null;
}

async function loadCharacter(userId: number): Promise<CharacterState> {
  const row = await dbGet<any>("SELECT * FROM characters WHERE user_id = ?", [userId]);

  return {
    level: row.level,
    xp: row.xp,
    xp_to_level: row.xp_to_level,
    base_max_hp: row.base_max_hp,
    base_atk_damage: row.base_atk_damage,
    inventory: JSON.parse(row.inventory_json),
    storage: JSON.parse(row.storage_json),
    equipped_weapon: parseItem(row.equipped_weapon_json),
    equipped_helmet: parseItem(row.equipped_helmet_json),
    equipped_chest: parseItem(row.equipped_chest_json),
    equipped_accessory: parseItem(row.equipped_accessory_json),
    world_x: row.world_x ?? null,
    world_y: row.world_y ?? null,
  };
}

async function createDefaultCharacter(userId: number) {
  await dbRun(
    `INSERT INTO characters (user_id, level, xp, xp_to_level, base_max_hp, base_atk_damage, inventory_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      DEFAULT_CHARACTER.level,
      DEFAULT_CHARACTER.xp,
      DEFAULT_CHARACTER.xp_to_level,
      DEFAULT_CHARACTER.base_max_hp,
      DEFAULT_CHARACTER.base_atk_damage,
      JSON.stringify(DEFAULT_CHARACTER.inventory),
    ]
  );
}

app.post("/api/register", ah(async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || username.trim().length < 3) {
    return res.status(400).json({ error: "Username must be at least 3 characters" });
  }
  if (!isUsernameAllowed(username)) {
    return res.status(400).json({ error: "That username isn't allowed - please pick another" });
  }
  if (typeof password !== "string" || password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }

  const existing = await dbGet("SELECT id FROM users WHERE username = ?", [username]);
  if (existing) {
    return res.status(409).json({ error: "Username already taken" });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const userId = await dbInsertId(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'student')",
    [username, passwordHash]
  );

  await createDefaultCharacter(userId);

  const token = generateToken();
  await dbRun("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, userId]);

  res.status(201).json({ token, character: await loadCharacter(userId) });
}));

app.post("/api/login", ah(async (req, res) => {
  const { username, password } = req.body ?? {};
  const user = await dbGet<{ id: number; password_hash: string; role: string }>(
    "SELECT * FROM users WHERE username = ?",
    [username]
  );

  if (!user || user.role !== "student" || !bcrypt.compareSync(password ?? "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  // Milestone 169: single active session per account, by direct request - two Chromebooks
  // logged into the same account both saved independently with no locking (last PUT wins),
  // silently stomping each other's inventory/position/XP. A fresh login now revokes every
  // other session first, so the old device's NEXT request (not instantly - there's no push
  // channel to it) gets a clean 401 "Invalid or expired token" instead of two live saves racing.
  await dbRun("DELETE FROM sessions WHERE user_id = ?", [user.id]);

  const token = generateToken();
  await dbRun("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, user.id]);

  res.json({ token, character: await loadCharacter(user.id) });
}));

app.get("/api/character", requireAuth, ah(async (req: AuthedRequest, res) => {
  res.json({ character: await loadCharacter(req.userId!) });
}));

app.put("/api/character", requireAuth, ah(async (req: AuthedRequest, res) => {
  const c = req.body as Partial<CharacterState>;

  await dbRun(
    `UPDATE characters SET
       level = ?,
       xp = ?,
       xp_to_level = ?,
       base_max_hp = ?,
       base_atk_damage = ?,
       inventory_json = ?,
       storage_json = ?,
       equipped_weapon_json = ?,
       equipped_helmet_json = ?,
       equipped_chest_json = ?,
       equipped_accessory_json = ?,
       world_x = ?,
       world_y = ?,
       updated_at = now()
     WHERE user_id = ?`,
    [
      c.level ?? DEFAULT_CHARACTER.level,
      c.xp ?? DEFAULT_CHARACTER.xp,
      c.xp_to_level ?? DEFAULT_CHARACTER.xp_to_level,
      c.base_max_hp ?? DEFAULT_CHARACTER.base_max_hp,
      c.base_atk_damage ?? DEFAULT_CHARACTER.base_atk_damage,
      JSON.stringify(c.inventory ?? []),
      JSON.stringify(c.storage ?? []),
      c.equipped_weapon ? JSON.stringify(c.equipped_weapon) : null,
      c.equipped_helmet ? JSON.stringify(c.equipped_helmet) : null,
      c.equipped_chest ? JSON.stringify(c.equipped_chest) : null,
      c.equipped_accessory ? JSON.stringify(c.equipped_accessory) : null,
      c.world_x ?? null,
      c.world_y ?? null,
      req.userId!,
    ]
  );

  res.json({ ok: true });
}));

// Milestone 77: the in-game settings menu's "change password" - works for either account role
// (requireAuth only, no requireRole), same as /api/character above, even though only the
// student-facing game client uses it today.
app.post("/api/change-password", requireAuth, ah(async (req: AuthedRequest, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (typeof current_password !== "string" || typeof new_password !== "string") {
    return res.status(400).json({ error: "current_password and new_password are required" });
  }
  if (new_password.length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters" });
  }

  const user = await dbGet<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    [req.userId!]
  );
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(new_password, 10), req.userId!]);
  res.json({ ok: true });
}));

app.post("/api/dungeon-runs", requireAuth, ah(async (req: AuthedRequest, res) => {
  const { dungeon_name, xp_gained } = req.body ?? {};
  if (typeof dungeon_name !== "string" || typeof xp_gained !== "number") {
    return res.status(400).json({ error: "dungeon_name (string) and xp_gained (number) required" });
  }

  await dbRun(
    "INSERT INTO dungeon_runs (user_id, dungeon_name, xp_gained) VALUES (?, ?, ?)",
    [req.userId!, dungeon_name, xp_gained]
  );

  res.status(201).json({ ok: true });
}));

// Catches anything forwarded via next(err) - every route above is wrapped in
// ah() specifically so a rejected promise (a dropped DB connection, a bad
// query) lands here instead of hanging the request. Must be registered last
// and keep all four params for Express to recognize it as error middleware.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

async function main() {
  await initDb();

  const server = app.listen(PORT, () => {
    console.log(`SMS Quest server listening on http://localhost:${PORT}`);
  });

  attachMultiplayer(server);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
