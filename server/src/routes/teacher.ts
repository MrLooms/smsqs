import { Router } from "express";
import bcrypt from "bcryptjs";
import { dbGet, dbAll, dbRun, dbInsertId, withTransaction } from "../db";
import { generateToken, requireAuth, requireRole, AuthedRequest } from "../auth";
import { ah } from "../asyncHandler";
import { parseCsv } from "../csv";

const router = Router();

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
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || username.trim().length < 3) {
    return res.status(400).json({ error: "Username must be at least 3 characters" });
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
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'teacher')",
    [username, passwordHash]
  );

  const token = generateToken();
  await dbRun("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, userId]);

  res.status(201).json({ token, username });
}));

router.post("/login", ah(async (req, res) => {
  const { username, password } = req.body ?? {};
  const user = await dbGet<{ id: number; username: string; password_hash: string; role: string }>(
    "SELECT * FROM users WHERE username = ?",
    [username]
  );

  if (!user || user.role !== "teacher" || !bcrypt.compareSync(password ?? "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = generateToken();
  await dbRun("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, user.id]);

  res.json({ token, username: user.username });
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
    `SELECT u.id AS student_id, u.username, m.joined_at FROM class_members m
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

  res.json({
    student: { id: studentId, username: member.username },
    overall,
    question_sets: Array.from(setsById.values()),
  });
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
