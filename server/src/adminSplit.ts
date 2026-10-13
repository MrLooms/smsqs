// Milestone 361: the admin account is separated from teaching. The teacher account (TEACHER_ACCOUNT) is registered normally on the teacher
// dashboard; the first time it exists (checked at boot and right after any teacher registers), everything the old "admin" teacher owned -
// classes and question sets - moves to it and the admin becomes role = 'admin' (strictly admin: no classes, no teacher dashboard, its own
// admin.html). Idempotent: once the admin's role is 'admin' there is nothing left to do.
import { dbGet, withTransaction } from "./db";

export const TEACHER_ACCOUNT = "Loomer";

export async function migrateAdminToTeacher(): Promise<boolean> {
  const t = await dbGet<{ id: number }>("SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND role = 'teacher' AND is_admin = false", [TEACHER_ACCOUNT]);
  if (!t) return false;
  const a = await dbGet<{ id: number; username: string }>("SELECT id, username FROM users WHERE is_admin = true AND role = 'teacher' ORDER BY id LIMIT 1");
  if (!a) return false;
  await withTransaction(async (query) => {
    await query("UPDATE classes SET teacher_id = ? WHERE teacher_id = ?", [t.id, a.id]);
    await query("UPDATE question_sets SET teacher_id = ? WHERE teacher_id = ?", [t.id, a.id]);
    await query("UPDATE users SET role = 'admin' WHERE id = ?", [a.id]);
  });
  console.log("[admin] moved " + a.username + "'s classes and question sets to " + TEACHER_ACCOUNT + "; " + a.username + " is now an admin-only account");
  return true;
}
