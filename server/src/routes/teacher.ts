import { Router } from "express";
import bcrypt from "bcryptjs";
import { dbGet, dbAll, dbRun, dbInsertId, withTransaction } from "../db";
import { LAST_ACTIVE_SQL, INACTIVE_WHERE_SQL, INACTIVE_DAYS, deleteAccountRows, isProtectedAccount } from "../activity";
import { generateToken, requireAuth, requireRole, requireAdmin, AuthedRequest } from "../auth";
import { ah } from "../asyncHandler";
import { parseCsv } from "../csv";
import { isUsernameAllowed } from "../usernameFilter";
import { sendPasswordResetEmail } from "../email";
import { parseTutorial, CHECKLIST_ITEMS, FEATURE_TOURS } from "../tutorial";
import { classInsights, studentInsights, classActivity, classProgress, classEvents, studentEvents } from "../insights";

const router = Router();

// Deliberately loose - just enough to catch a typo'd/empty field, not a full RFC 5322 validator.
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function generateJoinCode(): Promise<string> {
  // No 0/O/1/I/L - easy to misread on a projector, easy to mistype.
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let attempt = "";
  for (let tries = 0; tries < 20; tries++) {
    attempt = "";
    for (let i = 0; i < 6; i++) attempt += chars[Math.floor(Math.random() * chars.length)];
    const existing = await dbGet("SELECT id FROM classes WHERE join_code = ?", [attempt]);
    if (!existing) return attempt;
  }
  throw new Error("Could not generate a unique join code");
}

router.post("/register", ah(async (req, res) => {
  const { username, password, email } = req.body ?? {};
  if (typeof username !== "string" || username.trim().length < 3) {
    return res.status(400).json({ error: "Username must be at least 3 characters" });
  }
  if (!isUsernameAllowed(username)) {
    return res.status(400).json({ error: "That username isn't allowed - please pick another" });
  }
  if (typeof password !== "string" || password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }
  // Milestone 173: email is now required for a teacher account - it's the only way to recover a
  // forgotten password (students go through their teacher instead, see M100/M171). Existing
  // teacher accounts registered before this stay email-less; not retroactively enforced.
  if (typeof email !== "string" || !isValidEmail(email.trim())) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  // Case-insensitive, by direct request - matches the student side (index.ts) - "Bob" and "bob"
  // are the same account now, both here and at login below.
  const existing = await dbGet("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", [username]);
  if (existing) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const emailTaken = await dbGet("SELECT id FROM users WHERE email = ?", [email.trim()]);
  if (emailTaken) {
    return res.status(409).json({ error: "An account already uses that email" });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const userId = await dbInsertId(
    "INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, 'teacher', ?)",
    [username, passwordHash, email.trim()]
  );

  const token = generateToken();
  await dbRun("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, userId]);

  res.status(201).json({ token, username, is_admin: false });
}));

// Milestone 173: traditional email-based password recovery, teacher accounts only (students
// have no email on file - they go through their teacher instead, see M100/M171). Always
// responds the same way regardless of whether the email matches an account, so this can't be
// used to probe which emails are registered.
router.post("/forgot-password", ah(async (req, res) => {
  const { email } = req.body ?? {};
  if (typeof email !== "string" || !isValidEmail(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }

  const user = await dbGet<{ id: number }>(
    "SELECT id FROM users WHERE email = ? AND role = 'teacher'",
    [email.trim()]
  );

  if (user) {
    const resetToken = generateToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await dbRun(
      "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)",
      [resetToken, user.id, expiresAt]
    );
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://sms-quest-server.onrender.com";
    const resetUrl = `${baseUrl}/teacher.html?reset_token=${resetToken}`;
    // Best-effort - a real email failure (misconfigured Resend, no verified domain) shouldn't
    // reveal account existence via a different error message, so this stays silent either way.
    await sendPasswordResetEmail(email.trim(), resetUrl).catch(() => {});
  }

  res.json({ ok: true });
}));

router.post("/reset-password-with-token", ah(async (req, res) => {
  const { token: resetToken, new_password } = req.body ?? {};
  if (typeof resetToken !== "string" || resetToken.length === 0) {
    return res.status(400).json({ error: "Missing reset token" });
  }
  if (typeof new_password !== "string" || new_password.length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters" });
  }

  const row = await dbGet<{ user_id: number; expires_at: string }>(
    "SELECT user_id, expires_at FROM password_reset_tokens WHERE token = ?",
    [resetToken]
  );
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired - request a new one" });
  }

  await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(new_password, 10), row.user_id]);
  await dbRun("DELETE FROM password_reset_tokens WHERE token = ?", [resetToken]);
  res.json({ ok: true });
}));

router.post("/login", ah(async (req, res) => {
  const { username, password } = req.body ?? {};
  const user = await dbGet<{ id: number; username: string; password_hash: string; role: string; is_admin: boolean }>(
    "SELECT * FROM users WHERE LOWER(username) = LOWER(?)", // case-insensitive, by direct request
    [username]
  );

  if (!user || user.role !== "teacher" || !bcrypt.compareSync(password ?? "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = generateToken();
  await dbRun("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, user.id]);

  res.json({ token, username: user.username, is_admin: user.is_admin });
}));

// Everything below requires a teacher session.
router.use(requireAuth, requireRole("teacher"));

router.post("/classes", ah(async (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "Class name is required" });
  }

  const joinCode = await generateJoinCode();
  const id = await dbInsertId(
    "INSERT INTO classes (teacher_id, name, join_code) VALUES (?, ?, ?)",
    [req.userId!, name.trim(), joinCode]
  );

  res.status(201).json({ class: { id, name: name.trim(), join_code: joinCode } });
}));

router.get("/classes", ah(async (req: AuthedRequest, res) => {
  const classes = await dbAll(
    `SELECT c.id, c.name, c.join_code,
       (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id)::int AS student_count
     FROM classes c
     WHERE c.teacher_id = ?
     ORDER BY c.created_at DESC`,
    [req.userId!]
  );

  res.json({ classes });
}));

router.get("/classes/:id", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet<{ id: number; name: string; join_code: string }>(
    "SELECT * FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, req.userId!]
  );
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const roster = await dbAll(
    `SELECT u.id AS student_id, u.username, m.joined_at,
       ${LAST_ACTIVE_SQL} AS last_active,
       COALESCE((SELECT SUM(pa.seconds) FROM play_activity pa WHERE pa.user_id = u.id AND pa.day >= CURRENT_DATE - 6), 0)::int AS secs_7d,
       COALESCE((SELECT SUM(pa.seconds) FROM play_activity pa WHERE pa.user_id = u.id), 0)::int AS secs_total
     FROM class_members m
     JOIN users u ON u.id = m.student_id
     WHERE m.class_id = ? ORDER BY m.joined_at ASC`,
    [classId]
  );

  const assignedSets = await dbAll(
    `SELECT qs.id, qs.title, qs.subject, qs.grade
     FROM class_assignments ca
     JOIN question_sets qs ON qs.id = ca.question_set_id
     WHERE ca.class_id = ?`,
    [classId]
  );

  res.json({ class: cls, roster, assigned_sets: assignedSets });
}));

// "For each student show: questions attempted, accuracy, questions
// correct. For each question show: attempts, percentage correct." - the
// spec's own words for what this MVP analytics view needs to be. Nothing
// fancier (no mastery scoring, no per-topic breakdown here) until this is
// actually validated with real classroom use.
router.get("/classes/:id/analytics", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet(
    "SELECT id, name FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, req.userId!]
  );
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const students = await dbAll(
    `SELECT u.id AS student_id, u.username,
       COUNT(qa.id)::int AS attempts,
       COALESCE(SUM(qa.correct), 0)::int AS correct_count
     FROM class_members m
     JOIN users u ON u.id = m.student_id
     LEFT JOIN question_attempts qa ON qa.student_id = m.student_id AND qa.class_id = m.class_id
     WHERE m.class_id = ?
     GROUP BY u.id, u.username
     ORDER BY u.username ASC`,
    [classId]
  );

  const questions = await dbAll(
    `SELECT q.id, q.prompt, q.topic,
       COUNT(qa.id)::int AS attempts,
       COALESCE(SUM(qa.correct), 0)::int AS correct_count
     FROM class_assignments ca
     JOIN questions q ON q.question_set_id = ca.question_set_id
     LEFT JOIN question_attempts qa ON qa.question_id = CAST(q.id AS TEXT) AND qa.class_id = ca.class_id
     WHERE ca.class_id = ?
     GROUP BY q.id, q.prompt, q.topic
     ORDER BY q.id ASC`,
    [classId]
  );

  res.json({ class: cls, students, questions });
}));

// Milestone 303: who needs help and which topics need attention (insights.ts) - the dashboard's Overview, Students and Learning tabs.
router.get("/classes/:id/insights", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet("SELECT id, name FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });
  res.json({ class: cls, ...(await classInsights(classId)) });
}));

// Milestone 304: the Activity tab
router.get("/classes/:id/activity", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });
  res.json(await classActivity(classId));
}));

// Milestone 307: the event-log insights on the Game tab
router.get("/classes/:id/events", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });
  res.json(await classEvents(classId));
}));

// Milestone 305: the Game progress tab
router.get("/classes/:id/progress", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });
  res.json(await classProgress(classId));
}));

// One student's own breakdown, by question set and by individual question
// within each set - the analytics endpoint above only ever aggregates
// across the whole class, direct request for a per-student drill-down.
// Scoped to sets actually ASSIGNED to this class (not every set the teacher
// owns), same as the class-wide analytics above, so a student's numbers on
// a set they were never given don't show up as a wall of zero-attempt rows.
router.get("/classes/:id/students/:studentId", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const studentId = Number(req.params.studentId);

  const cls = await dbGet<{ id: number; name: string }>(
    "SELECT id, name FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, req.userId!]
  );
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const member = await dbGet<{ username: string }>(
    `SELECT u.username FROM class_members m
     JOIN users u ON u.id = m.student_id
     WHERE m.class_id = ? AND m.student_id = ?`,
    [classId, studentId]
  );
  if (!member) return res.status(404).json({ error: "Student not found in this class" });

  const overall = await dbGet<{ attempts: number; correct_count: number }>(
    "SELECT COUNT(*)::int AS attempts, COALESCE(SUM(correct), 0)::int AS correct_count FROM question_attempts WHERE student_id = ? AND class_id = ?",
    [studentId, classId]
  );

  // One flat row per (assigned set, question) with this student's own
  // attempt/correct counts on it (0/0 if they never touched it) - grouped
  // into sets below rather than queried per-set, so opening this view is
  // always exactly one round trip no matter how many sets are assigned.
  const rows = await dbAll<{
    set_id: number; set_title: string; question_id: number; prompt: string; topic: string | null;
    attempts: number; correct_count: number;
  }>(
    `SELECT qs.id AS set_id, qs.title AS set_title, q.id AS question_id, q.prompt, q.topic,
       COUNT(qa.id)::int AS attempts, COALESCE(SUM(qa.correct), 0)::int AS correct_count
     FROM class_assignments ca
     JOIN question_sets qs ON qs.id = ca.question_set_id
     JOIN questions q ON q.question_set_id = qs.id
     LEFT JOIN question_attempts qa ON qa.question_id = CAST(q.id AS TEXT) AND qa.student_id = ? AND qa.class_id = ca.class_id
     WHERE ca.class_id = ?
     GROUP BY qs.id, qs.title, q.id, q.prompt, q.topic
     ORDER BY qs.title ASC, q.id ASC`,
    [studentId, classId]
  );

  const setsById = new Map<number, { id: number; title: string; attempts: number; correct_count: number; questions: any[] }>();
  for (const r of rows) {
    if (!setsById.has(r.set_id)) {
      setsById.set(r.set_id, { id: r.set_id, title: r.set_title, attempts: 0, correct_count: 0, questions: [] });
    }
    const set = setsById.get(r.set_id)!;
    set.attempts += r.attempts;
    set.correct_count += r.correct_count;
    set.questions.push({ id: r.question_id, prompt: r.prompt, topic: r.topic, attempts: r.attempts, correct_count: r.correct_count });
  }

  // Milestone 274: play time and answer speed (play time is across the whole game, not just this class)
  const act = await dbGet<{ last_active: string; secs_7d: number; secs_total: number; sessions_7d: number }>(
    `SELECT ${LAST_ACTIVE_SQL} AS last_active,
       COALESCE((SELECT SUM(pa.seconds) FROM play_activity pa WHERE pa.user_id = u.id AND pa.day >= CURRENT_DATE - 6), 0)::int AS secs_7d,
       COALESCE((SELECT SUM(pa.seconds) FROM play_activity pa WHERE pa.user_id = u.id), 0)::int AS secs_total,
       (SELECT COUNT(*) FROM play_sessions p WHERE p.user_id = u.id AND p.last_seen >= now() - interval '7 days')::int AS sessions_7d
     FROM users u WHERE u.id = ?`,
    [studentId]
  );
  const days = await dbAll<{ day: string; seconds: number }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(seconds)::int AS seconds FROM play_activity WHERE user_id = ? AND day >= CURRENT_DATE - 13 GROUP BY day ORDER BY day",
    [studentId]
  );
  const areas = await dbAll<{ area: string; seconds: number }>(
    "SELECT area, SUM(seconds)::int AS seconds FROM play_activity WHERE user_id = ? AND day >= CURRENT_DATE - 29 GROUP BY area ORDER BY SUM(seconds) DESC",
    [studentId]
  );
  const speed = await dbGet<{ avg_ms: number | null; right_ms: number | null; wrong_ms: number | null; timed: number }>(
    `SELECT AVG(time_ms)::int AS avg_ms,
       AVG(time_ms) FILTER (WHERE correct = 1)::int AS right_ms,
       AVG(time_ms) FILTER (WHERE correct = 0)::int AS wrong_ms,
       COUNT(time_ms)::int AS timed
     FROM question_attempts WHERE student_id = ? AND class_id = ?`,
    [studentId, classId]
  );

  // Milestone 303: why this student is (or is not) flagged, and their topics and weekly accuracy
  const ci = await classInsights(classId);
  const mine = ci.students.find((x) => x.student_id === studentId);
  const si = await studentInsights(classId, studentId);
  const sev = await studentEvents(studentId);
  res.json({
    events: sev,
    insights: { flags: mine?.flags ?? [], topics: si.topics, weekly: si.weekly, accuracy_7d: mine?.accuracy_7d ?? null, class_accuracy: ci.summary.accuracy },
    student: { id: studentId, username: member.username },
    overall,
    play: { ...act, days, areas, avg_answer_ms: speed?.avg_ms ?? null, avg_right_ms: speed?.right_ms ?? null, avg_wrong_ms: speed?.wrong_ms ?? null, timed_answers: speed?.timed ?? 0 },
    question_sets: Array.from(setsById.values()),
  });
}));

// Milestone 297: Basic Training progress for a class - per student (done / skipped / still on step X / not started) and, for the
// whole class, how many students reached each step (where it stalls). Works from tutorial_json + tutorial_events (see tutorial.ts).
router.get("/classes/:id/tutorial", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });
  const rows = await dbAll<{ student_id: number; username: string; tutorial_json: string | null }>(
    `SELECT u.id AS student_id, u.username, c.tutorial_json
     FROM class_members m JOIN users u ON u.id = m.student_id LEFT JOIN characters c ON c.user_id = u.id
     WHERE m.class_id = ? ORDER BY u.username ASC`,
    [classId]
  );
  const students = rows.map((r) => {
    const st = parseTutorial(r.tutorial_json);
    const doneAt = st.done["basic"];
    return {
      student_id: r.student_id,
      username: r.username,
      status: doneAt ? (doneAt <= 1 ? "existing" : (st.skipped["basic"] ? "skipped" : "done")) : (st.step["basic"] ? "in_progress" : "not_started"),
      step: st.step["basic"] ?? null,
      // Milestone 306: Getting Started checklist and the feature tours (a legacy player - already playing before tutorials - has no checklist)
      checklist: {
        legacy: st.done["basic"] === 1 && !st.done["checklist"],
        done: !!st.done["checklist"] && st.done["checklist"] !== 1,
        ticked: (st.ticks["checklist"] ?? []).filter((i) => CHECKLIST_ITEMS.includes(i)),
      },
      tours: FEATURE_TOURS.filter((t) => st.done[t]),
    };
  });
  const steps = await dbAll<{ step: string; students: number }>(
    `SELECT e.step, COUNT(DISTINCT e.user_id)::int AS students
     FROM tutorial_events e JOIN class_members m ON m.student_id = e.user_id
     WHERE m.class_id = ? AND e.tut = 'basic' AND e.kind = 'step' GROUP BY e.step`,
    [classId]
  );
  res.json({ students, steps, checklist_items: CHECKLIST_ITEMS, tour_ids: FEATURE_TOURS });
}));

// Milestone 297: send a student (body { student_id }) - or the whole class (no student_id) - back through Basic Training. Their other
// tutorials are left alone. Only students in one of the teacher's own classes can be reset.
router.post("/classes/:id/tutorial/reset", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const cls = await dbGet("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });
  const sid = req.body?.student_id;
  const ids = (await dbAll<{ student_id: number }>(
    sid !== undefined && sid !== null
      ? "SELECT student_id FROM class_members WHERE class_id = ? AND student_id = ?"
      : "SELECT student_id FROM class_members WHERE class_id = ?",
    sid !== undefined && sid !== null ? [classId, Number(sid)] : [classId]
  )).map((r) => r.student_id);
  if (sid !== undefined && sid !== null && ids.length === 0) return res.status(404).json({ error: "Student not found in this class" });
  let n = 0;
  for (const id of ids) {
    await withTransaction(async (query) => {
      const r = await query("SELECT tutorial_json FROM characters WHERE user_id = ? FOR UPDATE", [id]);
      if (r.rows.length === 0) return;
      const st = parseTutorial(r.rows[0].tutorial_json);
      delete st.done["basic"];
      delete st.skipped["basic"];
      delete st.step["basic"];
      await query("UPDATE characters SET tutorial_json = ? WHERE user_id = ?", [JSON.stringify(st), id]);
      n++;
    });
  }
  res.json({ ok: true, reset: n });
}));

// Milestone 100: lets a teacher reset a student's password from the dashboard (a student
// forgetting theirs has no other recovery path - no email on file, no self-serve "forgot
// password" flow) - same class-ownership + membership scoping as the drill-down route above, so
// a teacher can only reset passwords for students actually in one of their own classes, not any
// account on the server. No old-password check needed here (unlike /api/change-password) - that
// verification is the whole thing being bypassed.
router.post("/classes/:id/students/:studentId/reset-password", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const studentId = Number(req.params.studentId);
  const { new_password } = req.body ?? {};

  if (typeof new_password !== "string" || new_password.length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters" });
  }

  const cls = await dbGet<{ id: number }>(
    "SELECT id FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, req.userId!]
  );
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const member = await dbGet(
    "SELECT student_id FROM class_members WHERE class_id = ? AND student_id = ?",
    [classId, studentId]
  );
  if (!member) return res.status(404).json({ error: "Student not found in this class" });

  await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(new_password, 10), studentId]);
  res.json({ ok: true });
}));

// Milestone 233: lets a teacher remove a student from their own class (roster management - a
// student who left the school, was added by mistake, etc.) - same class-ownership scoping as
// every other per-student route above. Only removes the ONE membership row, same as the
// student's own self-serve leave (POST /api/classes/:id/leave, student.ts) - the account itself,
// its characters, and its other class memberships are untouched. Same active_class_id fallback
// logic as that route too: if this class happened to be the student's active one, they fall back
// to their next most-recently-joined remaining membership, or null (practice-questions mode) if
// this was their last one.
router.delete("/classes/:id/students/:studentId", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const studentId = Number(req.params.studentId);

  const cls = await dbGet<{ id: number }>(
    "SELECT id FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, req.userId!]
  );
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const member = await dbGet(
    "SELECT student_id FROM class_members WHERE class_id = ? AND student_id = ?",
    [classId, studentId]
  );
  if (!member) return res.status(404).json({ error: "Student not found in this class" });

  await dbRun("DELETE FROM class_members WHERE class_id = ? AND student_id = ?", [classId, studentId]);

  const activeClass = await dbGet<{ active_class_id: number | null }>(
    "SELECT active_class_id FROM users WHERE id = ?",
    [studentId]
  );
  if (activeClass?.active_class_id === classId) {
    const next = await dbGet<{ class_id: number }>(
      "SELECT class_id FROM class_members WHERE student_id = ? ORDER BY joined_at DESC LIMIT 1",
      [studentId]
    );
    await dbRun("UPDATE users SET active_class_id = ? WHERE id = ?", [next?.class_id ?? null, studentId]);
  }

  res.json({ ok: true });
}));

// Milestone 171 (was M170's "/students/unassigned/reset-password"): the M100 route above only
// reaches a student in one of THIS teacher's own classes - a student who registered but never
// joined any class had no recovery path at all. The first version of this fix let ANY teacher
// reset ANY unassigned account, which is exactly the multi-teacher security gap flagged - a
// teacher shouldn't be able to touch an account outside their own classes just because it
// happens to be orphaned. Now admin-only (requireAdmin - see auth.ts's users.is_admin), and
// broadened along with it: an admin can reset ANY account's password, student or teacher, in a
// class or not - the whole point of a designated admin account is to have that one full-reach
// escape hatch instead of every teacher having a partial one.
// Milestone 172: no ambiguous characters (0/O, 1/l/I) - this gets read aloud or typed by hand,
// often by a young student, so misreads are the whole failure mode to avoid. Same reasoning as
// generateJoinCode() above, just longer (a password, not a projected join code).
function generateSimplePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

router.post("/admin/reset-password", requireAdmin, ah(async (req: AuthedRequest, res) => {
  const { username } = req.body ?? {};
  // Milestone 172: new_password is now optional - omit it (the account list's "Generate new
  // password" button does this) to get a random one back in the response instead of having to
  // make one up. The manual username/password fields above still pass an explicit one.
  let new_password = req.body?.new_password;

  if (typeof username !== "string" || username.trim().length === 0) {
    return res.status(400).json({ error: "Enter the account's username" });
  }
  if (new_password === undefined || new_password === "") {
    new_password = generateSimplePassword();
  } else if (typeof new_password !== "string" || new_password.length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters" });
  }

  const user = await dbGet<{ id: number }>("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", [username]); // case-insensitive, by direct request
  if (!user) return res.status(404).json({ error: "No account with that username" });

  await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(new_password, 10), user.id]);
  res.json({ ok: true, new_password });
}));

// Milestone 172: admin-only account search/list, by direct request. `?role=teacher|student`
// filters by type (omit/anything else = both), `?q=` is a case-insensitive substring match on
// username. NEVER returns password_hash - there's no "password" column to show, the actual
// password isn't recoverable from a bcrypt hash by design (that's the whole point of hashing
// it), so the dashboard's account list pairs with the reset-password route above instead of
// trying to display one.
router.get("/admin/accounts", requireAdmin, ah(async (req: AuthedRequest, res) => {
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

  // Milestone 274: when each account was last active (login, play, answer or dungeon run) and whether that is more
  // than INACTIVE_DAYS ago - the flagged ones can be deleted in bulk (below). The inactive list is oldest first.
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

// Admin-only account deletion, by direct request. Permanent: removes the account and everything
// that hangs off it, in one transaction so a failure part-way can't leave half an account behind.
//  - any account: sessions, password-reset tokens, character/save, dungeon runs, question attempts,
//    class memberships (as a student), then the user row itself
//  - a TEACHER additionally takes everything they own with them: their classes (and those classes'
//    memberships/assignments - students whose active class was one of them fall back to "no active
//    class"), their question sets and every question in them
// Guards: an admin account can't be deleted (this also covers deleting yourself), and the body must
// repeat the target's username ("confirm_username") so a stray click or a stale list row can't
// delete the wrong account - the dashboard's confirm prompt sends it.
router.delete("/admin/accounts/:id", requireAdmin, ah(async (req: AuthedRequest, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: "Invalid account id" });

  const target = await dbGet<{ id: number; username: string; role: string; is_admin: boolean }>(
    "SELECT id, username, role, is_admin FROM users WHERE id = ?",
    [targetId]
  );
  if (!target) return res.status(404).json({ error: "No such account" });
  if (target.is_admin || target.id === req.userId) {
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

// Milestone 274: bulk delete of INACTIVE accounts (no login, play, answer or dungeon run for INACTIVE_DAYS). Body:
// { ids: number[], confirm: "DELETE" }. Safe by construction: each id is re-checked against the inactivity rule right
// now (a stale list can't delete someone who has just played), admin and test accounts and yourself are always
// skipped, and everything runs in one transaction. A teacher in the list takes their classes and question sets with
// them (same as the single delete). Returns what was deleted and what was skipped, and why.
router.post("/admin/accounts/delete-inactive", requireAdmin, ah(async (req: AuthedRequest, res) => {
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
      if (r.id === req.userId || isProtectedAccount(r)) { skipped.push({ username: r.username, reason: "protected account" }); continue; }
      if (!r.inactive) { skipped.push({ username: r.username, reason: "active in the last " + INACTIVE_DAYS + " days" }); continue; }
      await deleteAccountRows(query, { id: r.id, role: r.role });
      deleted.push(r.username);
    }
  });
  res.json({ ok: true, deleted, skipped });
}));

router.post("/classes/:id/assign", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const { question_set_id } = req.body ?? {};

  const cls = await dbGet("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const set = await dbGet(
    "SELECT id FROM question_sets WHERE id = ? AND teacher_id = ?",
    [question_set_id, req.userId!]
  );
  if (!set) return res.status(404).json({ error: "Question set not found" });

  await dbRun(
    "INSERT INTO class_assignments (class_id, question_set_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [classId, question_set_id]
  );

  res.status(201).json({ ok: true });
}));

router.delete("/classes/:id/assign/:setId", ah(async (req: AuthedRequest, res) => {
  const classId = Number(req.params.id);
  const setId = Number(req.params.setId);

  const cls = await dbGet("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [classId, req.userId!]);
  if (!cls) return res.status(404).json({ error: "Class not found" });

  await dbRun("DELETE FROM class_assignments WHERE class_id = ? AND question_set_id = ?", [classId, setId]);
  res.json({ ok: true });
}));

router.post("/question-sets", ah(async (req: AuthedRequest, res) => {
  const { title, subject, grade } = req.body ?? {};
  if (typeof title !== "string" || title.trim().length === 0) {
    return res.status(400).json({ error: "Title is required" });
  }

  const id = await dbInsertId(
    "INSERT INTO question_sets (teacher_id, title, subject, grade) VALUES (?, ?, ?, ?)",
    [req.userId!, title.trim(), subject ?? null, grade ?? null]
  );

  res.status(201).json({ question_set: { id, title, subject, grade } });
}));

router.get("/question-sets", ah(async (req: AuthedRequest, res) => {
  const sets = await dbAll(
    `SELECT qs.id, qs.title, qs.subject, qs.grade,
       (SELECT COUNT(*) FROM questions q WHERE q.question_set_id = qs.id)::int AS question_count
     FROM question_sets qs
     WHERE qs.teacher_id = ?
     ORDER BY qs.created_at DESC`,
    [req.userId!]
  );

  res.json({ question_sets: sets });
}));

router.get("/question-sets/:id", ah(async (req: AuthedRequest, res) => {
  const setId = Number(req.params.id);
  const set = await dbGet<{ id: number; title: string; subject: string; grade: string }>(
    "SELECT * FROM question_sets WHERE id = ? AND teacher_id = ?",
    [setId, req.userId!]
  );
  if (!set) return res.status(404).json({ error: "Question set not found" });

  const rows = await dbAll<any>("SELECT * FROM questions WHERE question_set_id = ? ORDER BY id ASC", [setId]);

  const questions = rows.map((r) => ({
    id: r.id,
    question_type: r.question_type,
    prompt: r.prompt,
    answers: JSON.parse(r.answers_json),
    correct_index: r.correct_index,
    explanation: r.explanation,
    difficulty: r.difficulty,
    topic: r.topic,
    tags: JSON.parse(r.tags_json),
  }));

  res.json({ question_set: set, questions });
}));

router.put("/question-sets/:id", ah(async (req: AuthedRequest, res) => {
  const setId = Number(req.params.id);
  const { title, subject, grade } = req.body ?? {};

  const info = await dbRun(
    "UPDATE question_sets SET title = ?, subject = ?, grade = ? WHERE id = ? AND teacher_id = ?",
    [title, subject ?? null, grade ?? null, setId, req.userId!]
  );
  if (info.rowCount === 0) return res.status(404).json({ error: "Question set not found" });

  res.json({ ok: true });
}));

router.delete("/question-sets/:id", ah(async (req: AuthedRequest, res) => {
  const setId = Number(req.params.id);
  const set = await dbGet("SELECT id FROM question_sets WHERE id = ? AND teacher_id = ?", [setId, req.userId!]);
  if (!set) return res.status(404).json({ error: "Question set not found" });

  await dbRun("DELETE FROM questions WHERE question_set_id = ?", [setId]);
  await dbRun("DELETE FROM class_assignments WHERE question_set_id = ?", [setId]);
  await dbRun("DELETE FROM question_sets WHERE id = ?", [setId]);

  res.json({ ok: true });
}));

const CSV_REQUIRED_COLUMNS = ["question_type", "prompt", "answer_1", "answer_2", "correct_index"];
const CSV_OPTIONAL_COLUMNS = ["answer_3", "answer_4", "explanation", "difficulty", "topic", "tags"];

// Teacher-vetted content lands straight in as real questions - no draft/
// review step, unlike an AI-generation path would need. The teacher
// already decided what's in the file before uploading it.
router.post("/question-sets/:id/import-csv", ah(async (req: AuthedRequest, res) => {
  const setId = Number(req.params.id);
  const set = await dbGet("SELECT id FROM question_sets WHERE id = ? AND teacher_id = ?", [setId, req.userId!]);
  if (!set) return res.status(404).json({ error: "Question set not found" });

  const { csv } = req.body ?? {};
  if (typeof csv !== "string" || csv.trim().length === 0) {
    return res.status(400).json({ error: "csv (string) is required" });
  }

  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return res.status(400).json({ error: "CSV needs a header row plus at least one question row" });
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const colIndex: Record<string, number> = {};
  for (const col of [...CSV_REQUIRED_COLUMNS, ...CSV_OPTIONAL_COLUMNS]) {
    colIndex[col] = header.indexOf(col);
  }
  const missing = CSV_REQUIRED_COLUMNS.filter((col) => colIndex[col] === -1);
  if (missing.length > 0) {
    return res.status(400).json({ error: `CSV is missing required column(s): ${missing.join(", ")}` });
  }

  const get = (row: string[], col: string): string => {
    const idx = colIndex[col];
    return idx === -1 || idx === undefined ? "" : (row[idx] ?? "").trim();
  };

  type ParsedQuestion = {
    question_type: string;
    prompt: string;
    answers: string[];
    correct_index: number;
    explanation: string;
    difficulty: number;
    topic: string;
    tags: string[];
  };
  const parsed: ParsedQuestion[] = [];
  const rowErrors: Array<{ row: number; error: string }> = [];

  rows.slice(1).forEach((r, i) => {
    const rowNum = i + 2; // header is row 1, data is 1-indexed for the teacher
    if (r.every((cell) => cell.trim() === "")) return; // skip blank lines

    const question_type = (get(r, "question_type") || "mc").toLowerCase();
    if (question_type !== "mc" && question_type !== "tf") {
      rowErrors.push({ row: rowNum, error: `question_type must be 'mc' or 'tf', got '${question_type}'` });
      return;
    }

    const prompt = get(r, "prompt");
    if (!prompt) {
      rowErrors.push({ row: rowNum, error: "prompt is required" });
      return;
    }

    const answers =
      question_type === "tf"
        ? ["True", "False"]
        : [get(r, "answer_1"), get(r, "answer_2"), get(r, "answer_3"), get(r, "answer_4")].filter((a) => a !== "");
    if (answers.length < 2) {
      rowErrors.push({ row: rowNum, error: "mc questions need at least 2 answers" });
      return;
    }

    const correct_index = Number(get(r, "correct_index"));
    if (!Number.isInteger(correct_index) || correct_index < 0 || correct_index >= answers.length) {
      rowErrors.push({ row: rowNum, error: `correct_index must be a whole number from 0 to ${answers.length - 1}` });
      return;
    }

    const difficultyRaw = get(r, "difficulty");
    const difficulty = difficultyRaw ? Number(difficultyRaw) : 1;
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 3) {
      rowErrors.push({ row: rowNum, error: "difficulty must be 1, 2, or 3 (or left blank)" });
      return;
    }

    const tags = get(r, "tags")
      ? get(r, "tags").split(";").map((t) => t.trim()).filter(Boolean)
      : [];

    parsed.push({
      question_type,
      prompt,
      answers,
      correct_index,
      explanation: get(r, "explanation"),
      difficulty,
      topic: get(r, "topic"),
      tags,
    });
  });

  if (rowErrors.length > 0) {
    return res.status(400).json({ error: "CSV has errors - nothing was imported", row_errors: rowErrors });
  }
  if (parsed.length === 0) {
    return res.status(400).json({ error: "No question rows found" });
  }

  await withTransaction(async (query) => {
    for (const q of parsed) {
      await query(
        `INSERT INTO questions (question_set_id, question_type, prompt, answers_json, correct_index, explanation, difficulty, topic, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          setId,
          q.question_type,
          q.prompt,
          JSON.stringify(q.answers),
          q.correct_index,
          q.explanation,
          q.difficulty,
          q.topic,
          JSON.stringify(q.tags),
        ]
      );
    }
  });

  res.status(201).json({ imported: parsed.length });
}));

function validateQuestionBody(body: any): string | null {
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) return "Prompt is required";
  if (!Array.isArray(body.answers) || body.answers.length < 2) return "At least 2 answers are required";
  if (
    typeof body.correct_index !== "number" ||
    body.correct_index < 0 ||
    body.correct_index >= body.answers.length
  ) {
    return "correct_index must point at one of the answers";
  }
  return null;
}

router.post("/question-sets/:id/questions", ah(async (req: AuthedRequest, res) => {
  const setId = Number(req.params.id);
  const set = await dbGet("SELECT id FROM question_sets WHERE id = ? AND teacher_id = ?", [setId, req.userId!]);
  if (!set) return res.status(404).json({ error: "Question set not found" });

  const error = validateQuestionBody(req.body ?? {});
  if (error) return res.status(400).json({ error });

  const { question_type, prompt, answers, correct_index, explanation, difficulty, topic, tags } = req.body;

  const id = await dbInsertId(
    `INSERT INTO questions (question_set_id, question_type, prompt, answers_json, correct_index, explanation, difficulty, topic, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      setId,
      question_type ?? "mc",
      prompt.trim(),
      JSON.stringify(answers),
      correct_index,
      explanation ?? "",
      difficulty ?? 1,
      topic ?? "",
      JSON.stringify(tags ?? []),
    ]
  );

  res.status(201).json({ id });
}));

router.put("/questions/:id", ah(async (req: AuthedRequest, res) => {
  const questionId = Number(req.params.id);
  const owns = await dbGet(
    `SELECT q.id FROM questions q
     JOIN question_sets qs ON qs.id = q.question_set_id
     WHERE q.id = ? AND qs.teacher_id = ?`,
    [questionId, req.userId!]
  );
  if (!owns) return res.status(404).json({ error: "Question not found" });

  const error = validateQuestionBody(req.body ?? {});
  if (error) return res.status(400).json({ error });

  const { question_type, prompt, answers, correct_index, explanation, difficulty, topic, tags } = req.body;

  await dbRun(
    `UPDATE questions SET question_type = ?, prompt = ?, answers_json = ?, correct_index = ?,
       explanation = ?, difficulty = ?, topic = ?, tags_json = ? WHERE id = ?`,
    [
      question_type ?? "mc",
      prompt.trim(),
      JSON.stringify(answers),
      correct_index,
      explanation ?? "",
      difficulty ?? 1,
      topic ?? "",
      JSON.stringify(tags ?? []),
      questionId,
    ]
  );

  res.json({ ok: true });
}));

router.delete("/questions/:id", ah(async (req: AuthedRequest, res) => {
  const questionId = Number(req.params.id);
  const owns = await dbGet(
    `SELECT q.id FROM questions q
     JOIN question_sets qs ON qs.id = q.question_set_id
     WHERE q.id = ? AND qs.teacher_id = ?`,
    [questionId, req.userId!]
  );
  if (!owns) return res.status(404).json({ error: "Question not found" });

  await dbRun("DELETE FROM questions WHERE id = ?", [questionId]);
  res.json({ ok: true });
}));

export default router;
