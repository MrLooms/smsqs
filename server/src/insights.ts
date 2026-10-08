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

// Milestone 304: the Activity tab - who played on which days (last 14), how long and how often, and where the class spends its time.
export async function classActivity(classId: number) {
  const days = (await dbAll<{ day: string }>(
    "SELECT to_char(CURRENT_DATE - g, 'YYYY-MM-DD') AS day FROM generate_series(0, 13) g ORDER BY g DESC"
  )).map((r) => r.day);
  const roster = await dbAll<{ student_id: number; username: string }>(
    "SELECT u.id AS student_id, u.username FROM class_members m JOIN users u ON u.id = m.student_id WHERE m.class_id = ? ORDER BY u.username ASC",
    [classId]
  );
  const perDay = await dbAll<{ student_id: number; day: string; seconds: number }>(
    `SELECT pa.user_id AS student_id, to_char(pa.day, 'YYYY-MM-DD') AS day, SUM(pa.seconds)::int AS seconds
     FROM play_activity pa
     WHERE pa.user_id IN (SELECT student_id FROM class_members WHERE class_id = ?) AND pa.day >= CURRENT_DATE - 13
     GROUP BY 1, 2`,
    [classId]
  );
  const sessions = await dbAll<{ student_id: number; sessions: number; active_seconds: number }>(
    `SELECT p.user_id AS student_id, COUNT(*)::int AS sessions, COALESCE(SUM(p.active_seconds), 0)::int AS active_seconds
     FROM play_sessions p
     WHERE p.user_id IN (SELECT student_id FROM class_members WHERE class_id = ?) AND p.started_at >= now() - interval '14 days'
     GROUP BY 1`,
    [classId]
  );
  const areas = await dbAll<{ area: string; seconds: number }>(
    `SELECT pa.area, SUM(pa.seconds)::int AS seconds
     FROM play_activity pa
     WHERE pa.user_id IN (SELECT student_id FROM class_members WHERE class_id = ?) AND pa.day >= CURRENT_DATE - 13
     GROUP BY 1 ORDER BY 2 DESC`,
    [classId]
  );
  const answers = await dbAll<{ day: string; answers: number }>(
    `SELECT to_char(qa.attempted_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS answers
     FROM question_attempts qa
     WHERE qa.class_id = ? AND qa.attempted_at >= CURRENT_DATE - 13
     GROUP BY 1`,
    [classId]
  );

  const byStudent = new Map<number, Record<string, number>>();
  for (const r of perDay) {
    const m = byStudent.get(r.student_id) ?? {};
    m[r.day] = r.seconds;
    byStudent.set(r.student_id, m);
  }
  const sessBy = new Map(sessions.map((s) => [s.student_id, s]));
  const students = roster.map((r) => {
    const by_day = byStudent.get(r.student_id) ?? {};
    const secs = Object.values(by_day).reduce((a, b) => a + b, 0);
    const s = sessBy.get(r.student_id);
    return {
      student_id: r.student_id, username: r.username, by_day,
      secs_14d: secs,
      active_days_14d: Object.values(by_day).filter((v) => v > 0).length,
      sessions_14d: s?.sessions ?? 0,
      avg_session_secs: s && s.sessions > 0 ? Math.round(s.active_seconds / s.sessions) : null,
    };
  });
  const answersBy = new Map(answers.map((a) => [a.day, a.answers]));
  const class_days = days.map((day) => {
    let seconds = 0, active = 0;
    for (const st of students) {
      const v = st.by_day[day] ?? 0;
      seconds += v;
      if (v > 0) active += 1;
    }
    return { day, seconds, active_students: active, answers: answersBy.get(day) ?? 0 };
  });
  return { days, students, class_days, areas };
}

// Milestone 305: the Game progress tab - where each student is in the game. Read straight off the saved character, nothing new is
// collected. The "stage" follows the game's own order: a dungeon needs the previous biome's boss trophy, so the first biome with no
// boss kill is where the student is working now.
const BOSS_ORDER = ["desert", "swamp", "ice", "lava"];
const HOME_TIERS = ["Cottage", "House", "Manor"];

export function progressStage(bossKills: Record<string, number>, endlessBest: number): string {
  for (const b of BOSS_ORDER) {
    if (!(bossKills[b] > 0)) return b === "desert" ? "Forest - heading for the Desert" : "Working on the " + b[0].toUpperCase() + b.slice(1);
  }
  return endlessBest > 0 ? "Endless Dungeon" : "All four bosses beaten";
}

export async function classProgress(classId: number) {
  const rows = await dbAll<any>(
    `SELECT u.id AS student_id, u.username, u.endless_best, c.level, c.xp, c.inventory_json, c.lorekin_json, c.house_json,
       (SELECT COUNT(*)::int FROM dungeon_runs d WHERE d.user_id = u.id) AS runs_total,
       (SELECT COUNT(*)::int FROM dungeon_runs d WHERE d.user_id = u.id AND d.completed_at >= now() - interval '14 days') AS runs_14d,
       (SELECT MAX(d.completed_at) FROM dungeon_runs d WHERE d.user_id = u.id) AS last_run
     FROM class_members m JOIN users u ON u.id = m.student_id LEFT JOIN characters c ON c.user_id = u.id
     WHERE m.class_id = ? ORDER BY u.username ASC`,
    [classId]
  );
  const students = rows.map((r) => {
    let bossKills: Record<string, number> = {};
    let tier = 0;
    try {
      const inv = JSON.parse(r.inventory_json ?? "[]");
      const badge = Array.isArray(inv) ? inv.find((i: any) => i && i.badge) : undefined;
      if (badge) {
        bossKills = badge.boss_kills && typeof badge.boss_kills === "object" ? badge.boss_kills : {};
        tier = Number.isInteger(badge.max_unlocked_tier) ? badge.max_unlocked_tier : 0;
      }
    } catch { /* defaults */ }
    let lorekin = 0, topLorekin = 0;
    try {
      const list = JSON.parse(r.lorekin_json ?? "{}").list ?? [];
      lorekin = list.length;
      for (const e of list) if (Number.isInteger(e.level) && e.level > topLorekin) topLorekin = e.level;
    } catch { /* 0 */ }
    let home = "—", placed = 0;
    try {
      const h = JSON.parse(r.house_json ?? "{}");
      home = HOME_TIERS[Number.isInteger(h.tier) ? Math.max(0, Math.min(2, h.tier)) : 0];
      placed = Array.isArray(h.placed) ? h.placed.length : 0;
    } catch { /* defaults */ }
    const kills = BOSS_ORDER.reduce((n, b) => n + (bossKills[b] > 0 ? bossKills[b] : 0), 0);
    return {
      student_id: r.student_id, username: r.username,
      level: r.level ?? null,
      stage: progressStage(bossKills, r.endless_best ?? 0),
      world_tier: tier,
      boss_kills: BOSS_ORDER.map((b) => bossKills[b] > 0 ? bossKills[b] : 0),
      boss_kills_total: kills,
      runs_total: r.runs_total, runs_14d: r.runs_14d, last_run: r.last_run,
      endless_best: r.endless_best ?? 0,
      lorekin, top_lorekin_level: topLorekin,
      home, furniture: placed,
    };
  });
  const levels = students.map((s) => s.level).filter((l): l is number => l !== null).sort((a, b) => a - b);
  const median = levels.length ? levels[Math.floor(levels.length / 2)] : null;
  return { boss_order: BOSS_ORDER, students, median_level: median };
}

// Milestone 307: the event log rolled up for a class (last 14 days) - where students die, how dungeon runs go, which menus get used,
// gold, level pace, and where sessions end. Everything is a plain count so it can be read at a glance.
export async function classEvents(classId: number) {
  const inClass = "user_id IN (SELECT student_id FROM class_members WHERE class_id = ?)";
  const since = await dbAll<{ first: string | null }>(`SELECT MIN(at) AS first FROM game_events WHERE ${inClass}`, [classId]);
  const deaths = await dbAll<{ place: string; deaths: number; students: number }>(
    `SELECT detail AS place, SUM(n)::int AS deaths, COUNT(DISTINCT user_id)::int AS students
     FROM game_events WHERE kind = 'death' AND at >= now() - interval '14 days' AND ${inClass}
     GROUP BY detail ORDER BY 2 DESC LIMIT 12`,
    [classId]
  );
  const dungeon = await dbAll<{ kind: string; biome: string; total: number; students: number }>(
    `SELECT kind, detail AS biome, SUM(n)::int AS total, COUNT(DISTINCT user_id)::int AS students
     FROM game_events WHERE kind IN ('dungeon_in', 'dungeon_out', 'boss') AND at >= now() - interval '14 days' AND ${inClass}
     GROUP BY kind, detail`,
    [classId]
  );
  const panels = await dbAll<{ feature: string; uses: number; students: number }>(
    `SELECT detail AS feature, SUM(n)::int AS uses, COUNT(DISTINCT user_id)::int AS students
     FROM game_events WHERE kind = 'panel' AND at >= now() - interval '14 days' AND ${inClass}
     GROUP BY detail ORDER BY 3 DESC, 2 DESC`,
    [classId]
  );
  const per = await dbAll<{ user_id: number; kind: string; total: number }>(
    `SELECT user_id, kind, SUM(n)::int AS total
     FROM game_events WHERE at >= now() - interval '14 days' AND ${inClass} GROUP BY user_id, kind`,
    [classId]
  );
  const levels = await dbAll<{ user_id: number; top: number | null }>(
    `SELECT user_id, MAX(CASE WHEN detail ~ '^[0-9]+$' THEN detail::int END) AS top
     FROM game_events WHERE kind = 'level' AND at >= now() - interval '14 days' AND ${inClass} GROUP BY user_id`,
    [classId]
  );
  const roster = await dbAll<{ student_id: number; username: string }>(
    "SELECT u.id AS student_id, u.username FROM class_members m JOIN users u ON u.id = m.student_id WHERE m.class_id = ? ORDER BY u.username ASC",
    [classId]
  );
  const quits = await dbAll<{ place: string; sessions: number; students: number }>(
    `SELECT COALESCE(last_place, '') AS place, COUNT(*)::int AS sessions, COUNT(DISTINCT user_id)::int AS students
     FROM play_sessions
     WHERE ${inClass} AND started_at >= now() - interval '14 days' AND last_seen < now() - interval '5 minutes' AND active_seconds >= 60
     GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
    [classId]
  );

  const byUser = new Map<number, Record<string, number>>();
  for (const r of per) {
    const m = byUser.get(r.user_id) ?? {};
    m[r.kind] = r.total;
    byUser.set(r.user_id, m);
  }
  const topBy = new Map(levels.map((l) => [l.user_id, l.top]));
  const students = roster.map((r) => {
    const m = byUser.get(r.student_id) ?? {};
    return {
      student_id: r.student_id, username: r.username,
      deaths: m.death ?? 0, levels_gained: m.level ?? 0, top_level: topBy.get(r.student_id) ?? null,
      dungeons: m.dungeon_in ?? 0, bosses: m.boss ?? 0,
      gold_in: m.gold_in ?? 0, gold_out: m.gold_out ?? 0,
      crafts: m.craft ?? 0, enchants: m.enchant ?? 0, hatches: m.hatch ?? 0,
      quests_taken: m.quest_take ?? 0, quests_done: m.quest_done ?? 0,
      shop_buys: m.shop_buy ?? 0, shop_sells: m.shop_sell ?? 0,
    };
  });
  const gold_days = await dbAll<{ day: string; gold_in: number; gold_out: number }>(
    `SELECT to_char(at::date, 'YYYY-MM-DD') AS day,
       COALESCE(SUM(n) FILTER (WHERE kind = 'gold_in'), 0)::int AS gold_in, COALESCE(SUM(n) FILTER (WHERE kind = 'gold_out'), 0)::int AS gold_out
     FROM game_events WHERE kind IN ('gold_in', 'gold_out') AND at >= CURRENT_DATE - 13 AND ${inClass} GROUP BY 1 ORDER BY 1`,
    [classId]
  );
  // a place where several students keep dying is worth a look (too hard? too crowded? a bug?)
  const hotspots = deaths.filter((d) => d.students >= 3 && d.deaths >= 8);
  return { since: since[0]?.first ?? null, deaths, hotspots, gold_days, dungeon, panels, students, quits, students_total: roster.length };
}

// One student's own event picture (the student page's Game tab): where they die, gold by day, and the latest things they did.
export async function studentEvents(studentId: number) {
  const deaths = await dbAll<{ place: string; deaths: number }>(
    `SELECT detail AS place, SUM(n)::int AS deaths FROM game_events
     WHERE user_id = ? AND kind = 'death' AND at >= now() - interval '14 days' GROUP BY detail ORDER BY 2 DESC`,
    [studentId]
  );
  const gold_days = await dbAll<{ day: string; gold_in: number; gold_out: number }>(
    `SELECT to_char(at::date, 'YYYY-MM-DD') AS day,
       COALESCE(SUM(n) FILTER (WHERE kind = 'gold_in'), 0)::int AS gold_in, COALESCE(SUM(n) FILTER (WHERE kind = 'gold_out'), 0)::int AS gold_out
     FROM game_events WHERE user_id = ? AND kind IN ('gold_in', 'gold_out') AND at >= CURRENT_DATE - 13 GROUP BY 1 ORDER BY 1`,
    [studentId]
  );
  const counts = await dbAll<{ kind: string; total: number }>(
    `SELECT kind, SUM(n)::int AS total FROM game_events WHERE user_id = ? AND at >= now() - interval '14 days' GROUP BY kind`,
    [studentId]
  );
  const panels = await dbAll<{ feature: string; uses: number }>(
    `SELECT detail AS feature, SUM(n)::int AS uses FROM game_events
     WHERE user_id = ? AND kind = 'panel' AND at >= now() - interval '14 days' GROUP BY detail ORDER BY 2 DESC`,
    [studentId]
  );
  const recent = await dbAll<{ kind: string; detail: string; n: number; at: string }>(
    `SELECT kind, detail, n, at FROM game_events WHERE user_id = ? AND kind <> 'panel' AND kind NOT IN ('gold_in', 'gold_out') ORDER BY at DESC LIMIT 30`,
    [studentId]
  );
  const since = await dbAll<{ first: string | null }>("SELECT MIN(at) AS first FROM game_events WHERE user_id = ?", [studentId]);
  return { since: since[0]?.first ?? null, deaths, gold_days, counts, panels, recent };
}
