// Milestone 361: the admin account's own routes (mounted at /api/admin). The admin is not a teacher: no classes, no question sets, no teacher
// dashboard - just account management and the game-health analytics (activity, progress, event log, onboarding) that used to sit in each
// teacher's class view. Analytics scope is one class or "all" (every class on the server).
import { Router } from "express";
import bcrypt from "bcryptjs";
import { dbGet, dbAll, dbRun, withTransaction } from "../db";
import { LAST_ACTIVE_SQL, INACTIVE_WHERE_SQL, INACTIVE_DAYS, deleteAccountRows, isProtectedAccount } from "../activity";
import { requireAuth, requireAdmin, AuthedRequest } from "../auth";
import { ah } from "../asyncHandler";
import { classActivity, classProgress, classEvents, classTutorial } from "../insights";

const router = Router();
router.use(requireAuth, requireAdmin);

// Milestone 172: no ambiguous characters (0/O, 1/l/I) - this gets read aloud or typed by hand, often by a young student.
function generateSimplePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Reset ANY account's password (student or teacher, in a class or not). new_password optional: omitted = a random one comes back.
router.post("/reset-password", ah(async (req: AuthedRequest, res) => {
  const { username } = req.body ?? {};
  let new_password = req.body?.new_password;
  if (typeof username !== "string" || username.trim().length === 0) {
    return res.status(400).json({ error: "Enter the account's username" });
  }
  if (new_password === undefined || new_password === "") {
    new_password = generateSimplePassword();
  } else if (typeof new_password !== "string" || new_password.length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters" });
  }
  const user = await dbGet<{ id: number }>("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", [username]);
  if (!user) return res.status(404).json({ error: "No account with that username" });
  await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(new_password, 10), user.id]);
  res.json({ ok: true, new_password });
}));

// Account search/list. ?role=teacher|student, ?q= (username substring), ?inactive=1. Never returns a password hash.
router.get("/accounts", ah(async (req: AuthedRequest, res) => {
  const role = req.query.role === "teacher" || req.query.role === "student" ? req.query.role : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const onlyInactive = req.query.inactive === "1";

  const conditions: string[] = [];
  const params: any[] = [];
  if (role) {
    conditions.push("u.role = ?");
    params.push(role);
  }
  if (q.length > 0) {
    conditions.push("u.username ILIKE ?");
    params.push(`%${q}%`);
  }
  if (onlyInactive) conditions.push(INACTIVE_WHERE_SQL);
  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const accounts = await dbAll(
    `SELECT u.id, u.username, u.role, u.is_admin, ${LAST_ACTIVE_SQL} AS last_active,
       (${INACTIVE_WHERE_SQL}) AS inactive,
       COALESCE((SELECT SUM(pa.seconds) FROM play_activity pa WHERE pa.user_id = u.id), 0)::int AS secs_total
     FROM users u ${where}
     ORDER BY ${onlyInactive ? "last_active ASC" : "u.username ASC"} LIMIT 500`,
    params
  );
  const inactiveCount = await dbGet<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users u WHERE ${INACTIVE_WHERE_SQL}`);
  res.json({ accounts, inactive_days: INACTIVE_DAYS, inactive_total: inactiveCount?.n ?? 0 });
}));

// Permanent single-account delete (the body repeats the username). A teacher takes their classes and question sets with them.
router.delete("/accounts/:id", ah(async (req: AuthedRequest, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: "Invalid account id" });

  const target = await dbGet<{ id: number; username: string; role: string; is_admin: boolean }>(
    "SELECT id, username, role, is_admin FROM users WHERE id = ?",
    [targetId]
  );
  if (!target) return res.status(404).json({ error: "No such account" });
  if (target.is_admin || target.role === "admin" || target.id === req.userId) {
    return res.status(403).json({ error: "Admin accounts can't be deleted" });
  }
  const confirm = req.body?.confirm_username;
  if (typeof confirm !== "string" || confirm.trim().toLowerCase() !== target.username.toLowerCase()) {
    return res.status(400).json({ error: "Confirmation username doesn't match" });
  }
  await withTransaction(async (query) => {
    await deleteAccountRows(query, { id: targetId, role: target.role });
  });
  res.json({ ok: true, deleted: target.username });
}));

// Bulk delete of INACTIVE accounts. Body { ids, confirm: "DELETE" }; every id is re-checked server-side, protected accounts are skipped.
router.post("/accounts/delete-inactive", ah(async (req: AuthedRequest, res) => {
  if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: 'Type DELETE to confirm' });
  const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isInteger(n)) : [];
  if (ids.length === 0) return res.status(400).json({ error: "No accounts selected" });
  if (ids.length > 500) return res.status(400).json({ error: "Select at most 500 accounts at a time" });

  const rows = await dbAll<{ id: number; username: string; role: string; is_admin: boolean; inactive: boolean }>(
    `SELECT u.id, u.username, u.role, u.is_admin, (${INACTIVE_WHERE_SQL}) AS inactive FROM users u WHERE u.id = ANY(?::int[])`,
    [ids]
  );
  const deleted: string[] = [];
  const skipped: { username: string; reason: string }[] = [];
  await withTransaction(async (query) => {
    for (const r of rows) {
      if (r.id === req.userId || r.role === "admin" || isProtectedAccount(r)) { skipped.push({ username: r.username, reason: "protected account" }); continue; }
      if (!r.inactive) { skipped.push({ username: r.username, reason: "active in the last " + INACTIVE_DAYS + " days" }); continue; }
      await deleteAccountRows(query, { id: r.id, role: r.role });
      deleted.push(r.username);
    }
  });
  res.json({ ok: true, deleted, skipped });
}));

// ---- game health: every class on the server (with its teacher), then the analytics for one class or "all"
router.get("/classes", ah(async (_req: AuthedRequest, res) => {
  const classes = await dbAll(
    `SELECT c.id, c.name, u.username AS teacher,
       (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id)::int AS student_count
     FROM classes c JOIN users u ON u.id = c.teacher_id ORDER BY u.username ASC, c.name ASC`
  );
  res.json({ classes });
}));

async function scope(req: AuthedRequest): Promise<number[] | null> {
  if (req.params.id === "all") {
    return (await dbAll<{ id: number }>("SELECT id FROM classes")).map((r) => r.id);
  }
  const id = Number(req.params.id);
  const cls = await dbGet<{ id: number }>("SELECT id FROM classes WHERE id = ?", [id]);
  return cls ? [id] : null;
}

router.get("/classes/:id/activity", ah(async (req: AuthedRequest, res) => {
  const ids = await scope(req);
  if (!ids) return res.status(404).json({ error: "Class not found" });
  res.json(await classActivity(ids));
}));

router.get("/classes/:id/events", ah(async (req: AuthedRequest, res) => {
  const ids = await scope(req);
  if (!ids) return res.status(404).json({ error: "Class not found" });
  res.json(await classEvents(ids));
}));

router.get("/classes/:id/progress", ah(async (req: AuthedRequest, res) => {
  const ids = await scope(req);
  if (!ids) return res.status(404).json({ error: "Class not found" });
  res.json(await classProgress(ids));
}));

router.get("/classes/:id/tutorial", ah(async (req: AuthedRequest, res) => {
  const ids = await scope(req);
  if (!ids) return res.status(404).json({ error: "Class not found" });
  res.json(await classTutorial(ids));
}));

export default router;
