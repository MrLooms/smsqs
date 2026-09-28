import { Router } from "express";
import { dbGet, dbAll, dbRun } from "../db";
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
  const { question_id, topic, correct } = req.body ?? {};
  if (typeof correct !== "boolean") {
    return res.status(400).json({ error: "correct (boolean) is required" });
  }

  const activeClassId = await getActiveClassId(req.userId!);

  await dbRun(
    "INSERT INTO question_attempts (student_id, class_id, question_id, topic, correct) VALUES (?, ?, ?, ?, ?)",
    [req.userId!, activeClassId, question_id != null ? String(question_id) : null, topic ?? null, correct ? 1 : 0]
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

// Milestone 11: Class Town. A single shared structure (deliberately just
// one, not the spec's full blacksmith/library/shop/raid-hall - those need
// their own gameplay systems, e.g. something to actually buy, that don't
// exist yet) that visually advances through tiers as the whole class
// racks up correct answers. Thresholds are small on purpose so a
// real class can reach later tiers within a normal testing session -
// tune upward once this has been played with real numbers of students.
const CASTLE_TIERS = [
  { name: "Ruins", threshold: 0 },
  { name: "Foundations", threshold: 50 },
  { name: "Walls Rising", threshold: 150 },
  { name: "Towers Complete", threshold: 300 },
  { name: "The Grand Castle", threshold: 500 },
];

router.get("/my-class-progress", requireAuth, requireRole("student"), ah(async (req: AuthedRequest, res) => {
  const activeClassId = await getActiveClassId(req.userId!);

  if (!activeClassId) {
    return res.json({ has_class: false });
  }

  const cls = await dbGet<{ name: string }>("SELECT name FROM classes WHERE id = ?", [activeClassId]);
  const row = await dbGet<{ total_correct: number }>(
    "SELECT COALESCE(SUM(correct), 0)::int AS total_correct FROM question_attempts WHERE class_id = ?",
    [activeClassId]
  );

  let tierIndex = 0;
  for (let i = 0; i < CASTLE_TIERS.length; i++) {
    if (row!.total_correct >= CASTLE_TIERS[i].threshold) tierIndex = i;
  }
  const nextThreshold = tierIndex + 1 < CASTLE_TIERS.length ? CASTLE_TIERS[tierIndex + 1].threshold : null;

  res.json({
    has_class: true,
    class_name: cls!.name,
    total_correct: row!.total_correct,
    tier_index: tierIndex,
    tier_name: CASTLE_TIERS[tierIndex].name,
    next_threshold: nextThreshold,
  });
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

export default router;
