// Milestone 303: teacher insights - "which students need help" and "which topics need attention", computed from what the game already
// records (question_attempts incl. topic and answer time, play_activity, sessions). Everything here is class-scoped: the caller has
// already checked the class belongs to the requesting teacher. The rules are deliberately simple and explainable - every flag carries
// a plain-words reason - and the thresholds live in one place (T) so they can be tuned after real classroom use.

import { dbAll } from "./db";
import { LAST_ACTIVE_SQL } from "./activity";

export const T = {
  MIN_ATTEMPTS: 10,        // answers before a student can be called "struggling"
  STRUGGLE_BELOW: 0.5,     // accuracy under this = struggling (under HIGH_BELOW = high priority)
  HIGH_BELOW: 0.35,
  DECLINE_POINTS: 0.2,     // this-week accuracy this far under the previous two weeks = declining
  DECLINE_MIN: 5,          // answers needed in each window
  GUESS_MAX_MS: 3000,      // a median answer faster than this, with poor accuracy, looks like guessing
  GUESS_MIN_TIMED: 10,
  GUESS_BELOW: 0.6,
  INACTIVE_DAYS: 7,        // quiet this long = inactive
  NOT_STARTED_DAYS: 3,     // joined this long ago and never answered a question
  TOPIC_MIN_ATTEMPTS: 15,  // class-wide answers before a topic can be flagged "reteach"
  TOPIC_RETEACH_BELOW: 0.6,
  TOPIC_WATCH_BELOW: 0.7,
  TOPIC_WATCH_MIN: 8,
  TOPIC_STUDENT_MIN: 3,    // answers by one student on a topic before they count as struggling on it
};

export interface Flag {
  code: string;
  label: string;
  detail: string;
  level: "high" | "watch";
}

export interface StudentInsight {
  student_id: number;
  username: string;
  attempts: number;
  correct: number;
  accuracy: number | null;      // 0..1 over everything in this class
  attempts_7d: number;
  accuracy_7d: number | null;
  median_ms: number | null;
  last_active: string;
  days_since_active: number;
  secs_7d: number;
  secs_total: number;
  active_days_7d: number;
  flags: Flag[];
  attention: number;            // sort key: bigger = needs help sooner
}

export interface TopicInsight {
  topic: string;
  attempts: number;
  correct: number;
  accuracy: number;
  students: number;             // how many answered it
  struggling_students: number;  // how many of them are under STRUGGLE_BELOW on it
  attempts_14d: number;
  accuracy_14d: number | null;
  flag: "reteach" | "watch" | "";
  note: string;
}

const pct = (n: number) => Math.round(n * 100) + "%";

export function studentFlags(s: {
  attempts: number; correct: number; a7: number; c7: number; ap: number; cp: number; timed: number; median_ms: number | null;
  days_since_active: number; secs_total: number; days_in_class: number;
}): Flag[] {
  const flags: Flag[] = [];
  const acc = s.attempts > 0 ? s.correct / s.attempts : null;
  if (s.attempts >= T.MIN_ATTEMPTS && acc !== null && acc < T.STRUGGLE_BELOW) {
    flags.push({
      code: "struggling", label: "Struggling", level: acc < T.HIGH_BELOW ? "high" : "watch",
      detail: pct(acc) + " correct over " + s.attempts + " answers",
    });
  }
  if (s.a7 >= T.DECLINE_MIN && s.ap >= T.DECLINE_MIN) {
    const now = s.c7 / s.a7, before = s.cp / s.ap;
    if (before - now >= T.DECLINE_POINTS) {
      flags.push({ code: "declining", label: "Slipping", level: "watch", detail: "this week " + pct(now) + ", the two weeks before " + pct(before) });
    }
  }
  if (s.timed >= T.GUESS_MIN_TIMED && s.median_ms !== null && s.median_ms < T.GUESS_MAX_MS && acc !== null && acc < T.GUESS_BELOW) {
    flags.push({
      code: "guessing", label: "May be guessing", level: "watch",
      detail: "answers in " + (s.median_ms / 1000).toFixed(1) + "s on average but only " + pct(acc) + " are right",
    });
  }
  if (s.attempts === 0 && s.secs_total === 0 && s.days_in_class >= T.NOT_STARTED_DAYS) {
    flags.push({ code: "not_started", label: "Not started", level: "high", detail: "joined " + s.days_in_class + " days ago and has not played" });
  } else if (s.days_since_active >= T.INACTIVE_DAYS) {
    flags.push({ code: "inactive", label: "Inactive", level: s.days_since_active >= 14 ? "high" : "watch", detail: "last active " + s.days_since_active + " days ago" });
  }
  return flags;
}

export function topicFlag(t: { attempts: number; correct: number; students: number; struggling: number }): { flag: "reteach" | "watch" | ""; note: string } {
  const acc = t.attempts > 0 ? t.correct / t.attempts : 1;
  if (t.attempts >= T.TOPIC_MIN_ATTEMPTS && acc < T.TOPIC_RETEACH_BELOW && t.students >= 3) {
    return { flag: "reteach", note: "only " + pct(acc) + " right across " + t.students + " students" };
  }
  if (t.students >= 3 && t.struggling >= Math.max(2, Math.ceil(t.students * 0.4))) {
    return { flag: "reteach", note: t.struggling + " of " + t.students + " students are struggling with it" };
  }
  if (t.attempts >= T.TOPIC_WATCH_MIN && acc < T.TOPIC_WATCH_BELOW) {
    return { flag: "watch", note: pct(acc) + " right so far" };
  }
  return { flag: "", note: "" };
}

export async function classInsights(classId: number) {
  // 1) per-student answer stats for THIS class
  const att = await dbAll<any>(
    `SELECT qa.student_id,
       COUNT(*)::int AS attempts,
       COALESCE(SUM(qa.correct), 0)::int AS correct,
       COUNT(*) FILTER (WHERE qa.attempted_at >= now() - interval '7 days')::int AS a7,
       COALESCE(SUM(qa.correct) FILTER (WHERE qa.attempted_at >= now() - interval '7 days'), 0)::int AS c7,
       COUNT(*) FILTER (WHERE qa.attempted_at < now() - interval '7 days' AND qa.attempted_at >= now() - interval '21 days')::int AS ap,
       COALESCE(SUM(qa.correct) FILTER (WHERE qa.attempted_at < now() - interval '7 days' AND qa.attempted_at >= now() - interval '21 days'), 0)::int AS cp,
       COUNT(qa.time_ms)::int AS timed,
       (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY qa.time_ms))::int AS median_ms
     FROM question_attempts qa
     WHERE qa.class_id = ? GROUP BY qa.student_id`,
    [classId]
  );
  const attBy = new Map<number, any>(att.map((r) => [r.student_id, r]));

  // 2) the roster with play time and last activity
  const roster = await dbAll<any>(
    `SELECT u.id AS student_id, u.username,
       GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - m.joined_at)) / 86400))::int AS days_in_class,
       ${LAST_ACTIVE_SQL} AS last_active,
       GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - (${LAST_ACTIVE_SQL}))) / 86400))::int AS days_since_active,
       COALESCE((SELECT SUM(pa.seconds) FROM play_activity pa WHERE pa.user_id = u.id AND pa.day >= CURRENT_DATE - 6), 0)::int AS secs_7d,
       COALESCE((SELECT SUM(pa.seconds) FROM play_activity pa WHERE pa.user_id = u.id), 0)::int AS secs_total,
       (SELECT COUNT(DISTINCT pa.day) FROM play_activity pa WHERE pa.user_id = u.id AND pa.day >= CURRENT_DATE - 6)::int AS active_days_7d
     FROM class_members m JOIN users u ON u.id = m.student_id
     WHERE m.class_id = ? ORDER BY u.username ASC`,
    [classId]
  );

  const students: StudentInsight[] = roster.map((r) => {
    const a = attBy.get(r.student_id) ?? { attempts: 0, correct: 0, a7: 0, c7: 0, ap: 0, cp: 0, timed: 0, median_ms: null };
    const flags = studentFlags({ ...a, days_since_active: r.days_since_active, secs_total: r.secs_total, days_in_class: r.days_in_class });
    const attention = flags.reduce((n, f) => n + (f.level === "high" ? 3 : 1), 0);
    return {
      student_id: r.student_id, username: r.username,
      attempts: a.attempts, correct: a.correct,
      accuracy: a.attempts > 0 ? a.correct / a.attempts : null,
      attempts_7d: a.a7, accuracy_7d: a.a7 > 0 ? a.c7 / a.a7 : null,
      median_ms: a.median_ms,
      last_active: r.last_active, days_since_active: r.days_since_active,
      secs_7d: r.secs_7d, secs_total: r.secs_total, active_days_7d: r.active_days_7d,
      flags, attention,
    };
  });

  // 3) topics (class-wide) and who is struggling on each
  const topicRows = await dbAll<any>(
    `SELECT COALESCE(NULLIF(qa.topic, ''), '(no topic)') AS topic,
       COUNT(*)::int AS attempts, COALESCE(SUM(qa.correct), 0)::int AS correct,
       COUNT(DISTINCT qa.student_id)::int AS students,
       COUNT(*) FILTER (WHERE qa.attempted_at >= now() - interval '14 days')::int AS a14,
       COALESCE(SUM(qa.correct) FILTER (WHERE qa.attempted_at >= now() - interval '14 days'), 0)::int AS c14
     FROM question_attempts qa
     WHERE qa.class_id = ? AND qa.student_id IN (SELECT student_id FROM class_members WHERE class_id = ?)
     GROUP BY 1`,
    [classId, classId]
  );
  const perStudentTopic = await dbAll<any>(
    `SELECT COALESCE(NULLIF(qa.topic, ''), '(no topic)') AS topic, qa.student_id,
       COUNT(*)::int AS attempts, COALESCE(SUM(qa.correct), 0)::int AS correct
     FROM question_attempts qa
     WHERE qa.class_id = ? AND qa.student_id IN (SELECT student_id FROM class_members WHERE class_id = ?)
     GROUP BY 1, 2`,
    [classId, classId]
  );
  const strugglingBy = new Map<string, number>();
  for (const r of perStudentTopic) {
    if (r.attempts >= T.TOPIC_STUDENT_MIN && r.correct / r.attempts < T.STRUGGLE_BELOW) strugglingBy.set(r.topic, (strugglingBy.get(r.topic) ?? 0) + 1);
  }
  const topics: TopicInsight[] = topicRows.map((r) => {
    const struggling = strugglingBy.get(r.topic) ?? 0;
    const f = topicFlag({ attempts: r.attempts, correct: r.correct, students: r.students, struggling });
    return {
      topic: r.topic, attempts: r.attempts, correct: r.correct, accuracy: r.attempts > 0 ? r.correct / r.attempts : 0,
      students: r.students, struggling_students: struggling,
      attempts_14d: r.a14, accuracy_14d: r.a14 > 0 ? r.c14 / r.a14 : null,
      flag: f.flag, note: f.note,
    };
  });
  // flagged first (reteach, then watch), then weakest first
  const rank = (t: TopicInsight) => (t.flag === "reteach" ? 0 : t.flag === "watch" ? 1 : 2);
  topics.sort((a, b) => rank(a) - rank(b) || a.accuracy - b.accuracy || b.attempts - a.attempts);

  // 4) the class's weekly accuracy, last 8 weeks
  const weekly = await dbAll<any>(
    `SELECT to_char(date_trunc('week', qa.attempted_at), 'YYYY-MM-DD') AS week,
       COUNT(*)::int AS attempts, COALESCE(SUM(qa.correct), 0)::int AS correct, COUNT(DISTINCT qa.student_id)::int AS students
     FROM question_attempts qa
     WHERE qa.class_id = ? AND qa.attempted_at >= date_trunc('week', now()) - interval '7 weeks'
     GROUP BY 1 ORDER BY 1`,
    [classId]
  );

  const totalAttempts = students.reduce((n, s) => n + s.attempts, 0);
  const totalCorrect = students.reduce((n, s) => n + s.correct, 0);
  const a7 = students.reduce((n, s) => n + s.attempts_7d, 0);
  const c7 = students.reduce((n, s) => n + (s.accuracy_7d !== null ? Math.round(s.accuracy_7d * s.attempts_7d) : 0), 0);
  return {
    summary: {
      students: students.length,
      attempts: totalAttempts,
      accuracy: totalAttempts > 0 ? totalCorrect / totalAttempts : null,
      attempts_7d: a7,
      accuracy_7d: a7 > 0 ? c7 / a7 : null,
      active_students_7d: students.filter((s) => s.active_days_7d > 0 || s.attempts_7d > 0).length,
      needs_attention: students.filter((s) => s.flags.length > 0).length,
    },
    students,
    topics,
    weekly,
  };
}

// One student's topics and weekly accuracy within a class (the student page)
export async function studentInsights(classId: number, studentId: number) {
  const topics = await dbAll<any>(
    `SELECT COALESCE(NULLIF(qa.topic, ''), '(no topic)') AS topic, COUNT(*)::int AS attempts, COALESCE(SUM(qa.correct), 0)::int AS correct
     FROM question_attempts qa WHERE qa.class_id = ? AND qa.student_id = ? GROUP BY 1 ORDER BY (COALESCE(SUM(qa.correct),0)::float / COUNT(*)) ASC, COUNT(*) DESC`,
    [classId, studentId]
  );
  const weekly = await dbAll<any>(
    `SELECT to_char(date_trunc('week', qa.attempted_at), 'YYYY-MM-DD') AS week, COUNT(*)::int AS attempts, COALESCE(SUM(qa.correct), 0)::int AS correct
     FROM question_attempts qa WHERE qa.class_id = ? AND qa.student_id = ? AND qa.attempted_at >= date_trunc('week', now()) - interval '7 weeks'
     GROUP BY 1 ORDER BY 1`,
    [classId, studentId]
  );
  return { topics, weekly };
}
