// Milestone 362: self-grading question types beyond multiple choice / true-false. Everything here is exactly gradable by the game client (no free text
// and no review queue), so the attempt log still records one right/wrong per question.
//
// Storage: questions.answers_json holds the legacy answers array for mc/tf, and a DATA OBJECT for the rich types; correct_index is 0 for those.
// The API shows both as { answers, correct_index, data } (presentQuestionRow): answers is [] and data is the object for a rich type.
//
// data shapes:
//   match:       { pairs: [[left, right], ...] }                            2-6 pairs; the student drags each right item to its left
//   order:       { items: [...], start_label?, end_label? }                 3-7 items, listed in the CORRECT order (the game shuffles them)
//   sort:        { buckets: [...], items: [[text, bucketIndex], ...] }      2-3 buckets, 3-8 items
//   multi:       { options: [...], correct: [index, ...] }                  3-6 options, select all that apply
//   blank:       { text: "The [Ottawa] is in [Canada].", extra: [...] }     1-4 [blanks]; the word bank is the blanks + up to 4 decoys
//   tap:         { text: "The *quick* fox *jumps* over" }                   tap every *marked* word
//   unscramble:  { word: "capital" }                                        letters only, 3-12; the prompt is the clue
//   number:      { mode: "type"|"line", answers: [n, ...], tolerance, min?, max? }

export const CHOICE_TYPES = ["mc", "tf"];
export const RICH_TYPES = ["match", "order", "sort", "multi", "blank", "tap", "unscramble", "number"];
export const ALL_TYPES = [...CHOICE_TYPES, ...RICH_TYPES];

export interface NormalizedQuestion {
  question_type: string;
  answers_json: string;
  correct_index: number;
}
export type NormalizeResult = { ok: true; value: NormalizedQuestion } | { ok: false; error: string };

const fail = (error: string): NormalizeResult => ({ ok: false, error });
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const lower = (s: string) => s.toLowerCase();

function distinct(list: string[]): boolean {
  return new Set(list.map(lower)).size === list.length;
}

// Validates the data object for a rich type and returns the cleaned object (or an error message).
export function cleanRichData(type: string, d: any): { data: any } | { error: string } {
  if (!d || typeof d !== "object") return { error: "This question type needs its answer data" };
  switch (type) {
    case "match": {
      if (!Array.isArray(d.pairs)) return { error: "Add the pairs to match" };
      const pairs = d.pairs.map((p: any) => [text(p?.[0], 60), text(p?.[1], 60)]);
      if (pairs.length < 2 || pairs.length > 6) return { error: "A matching question needs 2 to 6 pairs" };
      if (pairs.some((p: string[]) => !p[0] || !p[1])) return { error: "Every pair needs both sides filled in" };
      if (!distinct(pairs.map((p: string[]) => p[0]))) return { error: "The left-hand items must all be different" };
      if (!distinct(pairs.map((p: string[]) => p[1]))) return { error: "The right-hand items must all be different" };
      return { data: { pairs } };
    }
    case "order": {
      if (!Array.isArray(d.items)) return { error: "Add the items to put in order" };
      const items = d.items.map((s: any) => text(s, 60));
      if (items.length < 3 || items.length > 7) return { error: "An ordering question needs 3 to 7 items" };
      if (items.some((s: string) => !s)) return { error: "Every item needs text" };
      if (!distinct(items)) return { error: "The items must all be different" };
      const out: any = { items };
      const a = text(d.start_label, 30), b = text(d.end_label, 30);
      if (a) out.start_label = a;
      if (b) out.end_label = b;
      return { data: out };
    }
    case "sort": {
      if (!Array.isArray(d.buckets) || !Array.isArray(d.items)) return { error: "Add the categories and the items to sort" };
      const buckets = d.buckets.map((s: any) => text(s, 30));
      if (buckets.length < 2 || buckets.length > 3) return { error: "A sorting question needs 2 or 3 categories" };
      if (buckets.some((s: string) => !s) || !distinct(buckets)) return { error: "Every category needs a different name" };
      const items = d.items.map((p: any) => [text(p?.[0], 50), Number(p?.[1])]);
      if (items.length < 3 || items.length > 8) return { error: "A sorting question needs 3 to 8 items" };
      if (items.some((p: any[]) => !p[0] || !Number.isInteger(p[1]) || p[1] < 0 || p[1] >= buckets.length)) {
        return { error: "Every item needs text and a category" };
      }
      for (let b = 0; b < buckets.length; b++) {
        if (!items.some((p: any[]) => p[1] === b)) return { error: `Nothing belongs in "${buckets[b]}" - every category needs at least one item` };
      }
      return { data: { buckets, items } };
    }
    case "multi": {
      if (!Array.isArray(d.options) || !Array.isArray(d.correct)) return { error: "Add the options and mark the correct ones" };
      const options = d.options.map((s: any) => text(s, 80));
      if (options.length < 3 || options.length > 6) return { error: "A select-all question needs 3 to 6 options" };
      if (options.some((s: string) => !s) || !distinct(options)) return { error: "Every option needs different text" };
      const correct = Array.from(new Set<number>(d.correct.map(Number))).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length).sort((a, b) => a - b);
      if (correct.length === 0) return { error: "Mark at least one correct option" };
      return { data: { options, correct } };
    }
    case "blank": {
      const t = text(d.text, 300);
      if (!t) return { error: "Write the sentence" };
      const blanks = [...t.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
      if (blanks.length < 1 || blanks.length > 4) return { error: "Put 1 to 4 answers in [square brackets] in the sentence" };
      if (blanks.some((b) => b.length === 0 || b.length > 30)) return { error: "Each blank answer must be 1 to 30 characters" };
      const extra = (Array.isArray(d.extra) ? d.extra : []).map((s: any) => text(s, 30)).filter((s: string) => s);
      if (extra.length > 4) return { error: "At most 4 extra (wrong) words" };
      return { data: { text: t, extra } };
    }
    case "tap": {
      const t = text(d.text, 400);
      if (!t) return { error: "Write the sentence" };
      const words = t.split(" ");
      if (words.length > 40) return { error: "Keep the sentence to 40 words" };
      const marked = words.filter((w) => /^\*.+\*[.,!?;:"')]*$/.test(w)).length;
      if (marked === 0) return { error: "Mark at least one word to tap by putting *asterisks* around it" };
      if (marked === words.length) return { error: "Leave at least one word unmarked" };
      return { data: { text: t } };
    }
    case "unscramble": {
      const w = text(d.word, 20);
      if (!/^[A-Za-z]{3,12}$/.test(w)) return { error: "The word must be 3 to 12 letters, no spaces" };
      if (new Set(lower(w).split("")).size < 2) return { error: "The word needs at least 2 different letters" };
      return { data: { word: w } };
    }
    case "number": {
      const mode = d.mode === "line" ? "line" : "type";
      const answers = (Array.isArray(d.answers) ? d.answers : []).map(Number).filter((n: number) => Number.isFinite(n));
      if (answers.length < 1 || answers.length > 5) return { error: "Give 1 to 5 accepted numbers" };
      let tolerance = Number(d.tolerance ?? 0);
      if (!Number.isFinite(tolerance) || tolerance < 0) return { error: "Tolerance must be 0 or more" };
      if (mode === "type") return { data: { mode, answers, tolerance } };
      const min = Number(d.min), max = Number(d.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return { error: "The number line needs a minimum below its maximum" };
      if (answers[0] < min || answers[0] > max) return { error: "The answer must be on the number line" };
      if (tolerance === 0) tolerance = (max - min) / 50;
      return { data: { mode, answers: [answers[0]], tolerance, min, max } };
    }
  }
  return { error: "Unknown question type" };
}

// One question from the editor (JSON body) or the CSV importer: { question_type, prompt, answers?, correct_index?, data? }.
export function normalizeQuestion(q: any): NormalizeResult {
  const type = typeof q?.question_type === "string" && q.question_type ? q.question_type : "mc";
  if (!ALL_TYPES.includes(type)) return fail(`question_type must be one of: ${ALL_TYPES.join(", ")}`);
  if (typeof q.prompt !== "string" || q.prompt.trim().length === 0) return fail("Prompt is required");
  if (q.prompt.length > 500) return fail("Keep the prompt under 500 characters");

  if (CHOICE_TYPES.includes(type)) {
    if (!Array.isArray(q.answers) || q.answers.length < 2) return fail("At least 2 answers are required");
    if (typeof q.correct_index !== "number" || q.correct_index < 0 || q.correct_index >= q.answers.length) {
      return fail("correct_index must point at one of the answers");
    }
    return { ok: true, value: { question_type: type, answers_json: JSON.stringify(q.answers), correct_index: q.correct_index } };
  }
  const cleaned = cleanRichData(type, q.data);
  if ("error" in cleaned) return fail(cleaned.error);
  return { ok: true, value: { question_type: type, answers_json: JSON.stringify(cleaned.data), correct_index: 0 } };
}

// A questions row as the API returns it.
export function presentQuestionRow(r: { answers_json: string; correct_index: number }): { answers: any[]; correct_index: number; data: any | null } {
  let parsed: any = [];
  try { parsed = JSON.parse(r.answers_json); } catch { /* corrupt row: shows as an empty question */ }
  if (Array.isArray(parsed)) return { answers: parsed, correct_index: r.correct_index, data: null };
  return { answers: [], correct_index: 0, data: parsed };
}

// ---- CSV: the compact `data` column per type (answer_1..answer_4 carry labels for order / buckets for sort) ----
//   match:       Ottawa=Capital of Canada|Toronto=Capital of Ontario|Victoria=Capital of BC
//   order:       Egg|Caterpillar|Chrysalis|Butterfly            (answer_1 / answer_2 = optional start / end label, e.g. Earliest / Latest)
//   sort:        Defence=Federal|Health=Provincial|Garbage=Municipal   (answer_1..answer_3 = the category names)
//   multi:       Ottawa*|Toronto|Montreal|Victoria*             (a trailing * marks a correct option)
//   blank:       The [Ottawa] is the capital of [Canada].|Toronto|Quebec     (text first, then optional extra words)
//   tap:         The *quick* fox *jumps* over the dog
//   unscramble:  capital
//   number:      56   or   3.14~0.01   (answer~tolerance)   or  0.5|1/2   (several accepted)   or  line 0 100 50~2  (a number line)
export function dataFromCsv(type: string, dataStr: string, answers: string[]): { data: any } | { error: string } {
  const s = dataStr.trim();
  if (!s) return { error: `${type} questions need the data column filled in` };
  const parts = s.split("|").map((x) => x.trim()).filter((x) => x !== "");
  switch (type) {
    case "match": {
      const pairs = parts.map((p) => {
        const i = p.indexOf("=");
        return i < 0 ? [p, ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      });
      return { data: { pairs } };
    }
    case "order": {
      const out: any = { items: parts };
      if (answers[0]) out.start_label = answers[0];
      if (answers[1]) out.end_label = answers[1];
      return { data: out };
    }
    case "sort": {
      const buckets = answers.filter((a) => a !== "");
      const items = parts.map((p) => {
        const i = p.lastIndexOf("=");
        const name = i < 0 ? "" : p.slice(i + 1).trim();
        const b = buckets.findIndex((x) => lower(x) === lower(name));
        return [i < 0 ? p : p.slice(0, i).trim(), b];
      });
      if (items.some((it) => it[1] === -1)) return { error: "each item must end in =CategoryName using one of the categories in answer_1..answer_3" };
      return { data: { buckets, items } };
    }
    case "multi": {
      const options: string[] = [];
      const correct: number[] = [];
      parts.forEach((p, i) => {
        if (p.endsWith("*")) { correct.push(i); options.push(p.slice(0, -1).trim()); } else options.push(p);
      });
      return { data: { options, correct } };
    }
    case "blank":
      return { data: { text: parts[0] ?? "", extra: parts.slice(1) } };
    case "tap":
      return { data: { text: s } };
    case "unscramble":
      return { data: { word: s } };
    case "number": {
      const m = /^line\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:~([\d.]+))?$/i.exec(s);
      if (m) return { data: { mode: "line", min: Number(m[1]), max: Number(m[2]), answers: [Number(m[3])], tolerance: m[4] ? Number(m[4]) : 0 } };
      let tolerance = 0;
      const nums: number[] = [];
      for (const p of parts) {
        const [val, tol] = p.split("~");
        if (tol !== undefined && Number.isFinite(Number(tol))) tolerance = Math.max(tolerance, Number(tol));
        const frac = /^(-?[\d.]+)\s*\/\s*([\d.]+)$/.exec(val.trim());
        const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(val);
        if (!Number.isFinite(n)) return { error: `"${p}" is not a number` };
        nums.push(n);
      }
      return { data: { mode: "type", answers: nums, tolerance } };
    }
  }
  return { error: "Unknown question type" };
}
