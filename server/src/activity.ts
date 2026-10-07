// Milestone 274: playtime + session tracking. The game sends a heartbeat about once a minute while it is open
// (POST /api/heartbeat); the server credits the time since that session's previous heartbeat (capped, so a closed
// laptop never counts) to play_activity - per user, per day, per area - and only when the client says the player was
// actually doing something. play_sessions is one row per game launch.
import { isTestName } from "./testAccount";

export const INACTIVE_DAYS = 30;

// Areas the game reports. Anything else is stored as "other".
export const PLAY_AREAS = ["hub", "interior", "overworld", "dungeon", "questions", "menu"];

// When an account was last active, as an SQL expression over a users row aliased "u": the latest of the account's
// creation, its last login (the sessions row is replaced on every login), the last heartbeat, the last question
// answered and the last dungeon run. Never NULL.
export const LAST_ACTIVE_SQL = `GREATEST(
  u.created_at,
  COALESCE((SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id), u.created_at),
  COALESCE((SELECT MAX(p.last_seen) FROM play_sessions p WHERE p.user_id = u.id), u.created_at),
  COALESCE((SELECT MAX(qa.attempted_at) FROM question_attempts qa WHERE qa.student_id = u.id), u.created_at),
  COALESCE((SELECT MAX(d.completed_at) FROM dungeon_runs d WHERE d.user_id = u.id), u.created_at)
)`;

export const INACTIVE_WHERE_SQL = `(${LAST_ACTIVE_SQL}) < now() - interval '${INACTIVE_DAYS} days'`;

// Removes an account and everything that hangs off it (the caller runs this inside a transaction).
// A TEACHER also takes their classes, question sets and questions with them.
export async function deleteAccountRows(
  query: (sql: string, params?: any[]) => Promise<unknown>,
  target: { id: number; role: string }
) {
  const id = target.id;
  if (target.role === "teacher") {
    await query("UPDATE users SET active_class_id = NULL WHERE active_class_id IN (SELECT id FROM classes WHERE teacher_id = ?)", [id]);
    await query("DELETE FROM class_members WHERE class_id IN (SELECT id FROM classes WHERE teacher_id = ?)", [id]);
    await query(
      "DELETE FROM class_assignments WHERE class_id IN (SELECT id FROM classes WHERE teacher_id = ?) OR question_set_id IN (SELECT id FROM question_sets WHERE teacher_id = ?)",
      [id, id]
    );
    await query("DELETE FROM classes WHERE teacher_id = ?", [id]);
    await query("DELETE FROM questions WHERE question_set_id IN (SELECT id FROM question_sets WHERE teacher_id = ?)", [id]);
    await query("DELETE FROM question_sets WHERE teacher_id = ?", [id]);
  }
  await query("DELETE FROM sessions WHERE user_id = ?", [id]);
  await query("DELETE FROM password_reset_tokens WHERE user_id = ?", [id]);
  await query("DELETE FROM play_sessions WHERE user_id = ?", [id]);
  await query("DELETE FROM play_activity WHERE user_id = ?", [id]);
  await query("DELETE FROM dungeon_runs WHERE user_id = ?", [id]);
  await query("DELETE FROM question_attempts WHERE student_id = ?", [id]);
  await query("DELETE FROM class_members WHERE student_id = ?", [id]);
  await query("DELETE FROM characters WHERE user_id = ?", [id]);
  await query("DELETE FROM users WHERE id = ?", [id]);
}

// An account the bulk delete must never touch, whatever its activity.
export const isProtectedAccount = (u: { username: string; is_admin: boolean }) => u.is_admin || isTestName(u.username);
