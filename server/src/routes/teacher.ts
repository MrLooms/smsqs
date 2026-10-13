import { Router } from "express";
import bcrypt from "bcryptjs";
import { dbGet, dbAll, dbRun, dbInsertId, withTransaction } from "../db";
import { migrateAdminToTeacher } from "../adminSplit";
import { ALL_TYPES, CHOICE_TYPES, normalizeQuestion, presentQuestionRow, dataFromCsv } from "../questionTypes";
import { LAST_ACTIVE_SQL } from "../activity";
import { generateToken, requireAuth, requireRole, AuthedRequest } from "../auth";
import { ah } from "../asyncHandler";
import { parseCsv } from "../csv";
import { isUsernameAllowed } from "../usernameFilter";
import { sendPasswordResetEmail } from "../email";
import { classInsights, studentInsights } from "../insights";

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

  // Milestone 361: the teacher account the admin's classes move to (adminSplit.ts) may just have been created
  migrateAdminToTeacher().catch((e) => console.error("[admin] migration failed:", e));

  res.status(201).json({ token, username, is_admin: false, role: "teacher" });
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
    "SELECT id FROM users WHERE email = ? AND role IN ('teacher', 'admin')",
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

  if (!user || (user.role !== "teacher" && user.role !== "admin") || !bcrypt.compareSync(password ?? "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = generateToken();
  await dbRun("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, user.id]);

  res.json({ token, username: user.username, is_admin: user.is_admin, role: user.role });
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
  res.json({
    insights: { flags: mine?.flags ?? [], topics: si.topics, weekly: si.weekly, accuracy_7d: mine?.accuracy_7d ?? null, class_accuracy: ci.summary.accuracy },
    student: { id: studentId, username: member.username },
    overall,
    play: { ...act, avg_answer_ms: speed?.avg_ms ?? null, avg_right_ms: speed?.right_ms ?? null, avg_wrong_ms: speed?.wrong_ms ?? null, timed_answers: speed?.timed ?? 0 },
    question_sets: Array.from(setsById.values()),
  });
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
    ...presentQuestionRow(r), // answers + correct_index (mc/tf) or data (the self-grading types, Milestone 362)
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

const CSV_REQUIRED_COLUMNS = ["question_type", "prompt"];
const CSV_OPTIONAL_COLUMNS = ["answer_1", "answer_2", "answer_3", "answer_4", "correct_index", "data", "explanation", "difficulty", "topic", "tags"];

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
    answers_json: string;
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
    if (!ALL_TYPES.includes(question_type)) {
      rowErrors.push({ row: rowNum, error: `question_type must be one of ${ALL_TYPES.join(", ")}, got '${question_type}'` });
      return;
    }

    const prompt = get(r, "prompt");
    if (!prompt) {
      rowErrors.push({ row: rowNum, error: "prompt is required" });
      return;
    }

    let answers_json = "";
    let correct_index = 0;
    if (CHOICE_TYPES.includes(question_type)) {
      const answers =
        question_type === "tf"
          ? ["True", "False"]
          : [get(r, "answer_1"), get(r, "answer_2"), get(r, "answer_3"), get(r, "answer_4")].filter((a) => a !== "");
      if (answers.length < 2) {
        rowErrors.push({ row: rowNum, error: "mc questions need at least 2 answers" });
        return;
      }
      correct_index = Number(get(r, "correct_index"));
      if (!Number.isInteger(correct_index) || correct_index < 0 || correct_index >= answers.length) {
        rowErrors.push({ row: rowNum, error: `correct_index must be a whole number from 0 to ${answers.length - 1}` });
        return;
      }
      answers_json = JSON.stringify(answers);
    } else {
      // Milestone 362: the self-grading types read their compact `data` column (see questionTypes.ts for each type's syntax)
      const fromCsv = dataFromCsv(question_type, get(r, "data"), [get(r, "answer_1"), get(r, "answer_2"), get(r, "answer_3"), get(r, "answer_4")]);
      if ("error" in fromCsv) {
        rowErrors.push({ row: rowNum, error: fromCsv.error });
        return;
      }
      const norm = normalizeQuestion({ question_type, prompt, data: fromCsv.data });
      if (!norm.ok) {
        rowErrors.push({ row: rowNum, error: norm.error });
        return;
      }
      answers_json = norm.value.answers_json;
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
      answers_json,
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
          q.answers_json,
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

router.post("/question-sets/:id/questions", ah(async (req: AuthedRequest, res) => {
  const setId = Number(req.params.id);
  const set = await dbGet("SELECT id FROM question_sets WHERE id = ? AND teacher_id = ?", [setId, req.userId!]);
  if (!set) return res.status(404).json({ error: "Question set not found" });

  const norm = normalizeQuestion(req.body ?? {});
  if (!norm.ok) return res.status(400).json({ error: norm.error });

  const { prompt, explanation, difficulty, topic, tags } = req.body;

  const id = await dbInsertId(
    `INSERT INTO questions (question_set_id, question_type, prompt, answers_json, correct_index, explanation, difficulty, topic, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      setId,
      norm.value.question_type,
      prompt.trim(),
      norm.value.answers_json,
      norm.value.correct_index,
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

  const norm = normalizeQuestion(req.body ?? {});
  if (!norm.ok) return res.status(400).json({ error: norm.error });

  const { prompt, explanation, difficulty, topic, tags } = req.body;

  await dbRun(
    `UPDATE questions SET question_type = ?, prompt = ?, answers_json = ?, correct_index = ?,
       explanation = ?, difficulty = ?, topic = ?, tags_json = ? WHERE id = ?`,
    [
      norm.value.question_type,
      prompt.trim(),
      norm.value.answers_json,
      norm.value.correct_index,
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
