// Milestone 297: new-player tutorials. Per-account progress is one opaque JSON blob on the character (tutorial_json), changed only
// through the /api/tutorial/* routes (students) and the teacher dashboard's reset - never the character PUT. Each tutorial has an id
// ("basic" = the mandatory Basic Training, later "house", "smith", ...). The blob remembers which are done (and whether they were
// skipped), and the step the player is on, so a half-finished training resumes on any device.
//
// tutorial_events is a plain log of step reached / done / skipped, which the teacher dashboard sums to show where a class stalls.

export interface TutorialState {
  done: Record<string, number>;     // tutorial id -> when it was finished (ms since epoch)
  skipped: Record<string, boolean>; // finished by pressing Skip rather than by doing the steps
  step: Record<string, string>;     // tutorial id -> the step the player is on now
  ticks: Record<string, string[]>;  // checklist-style tutorial id -> the items ticked so far (Getting Started)
}

// Milestone 299: the Getting Started checklist. Finishing it (every item ticked) pays the Common Egg, once.
export const CHECKLIST_ITEMS = ["class", "quest", "home", "craft", "dungeon", "boss", "crystal"];

export function freshTutorial(): TutorialState {
  return { done: {}, skipped: {}, step: {}, ticks: {} };
}

export function parseTutorial(json: string | null | undefined): TutorialState {
  const st = freshTutorial();
  if (!json) return st;
  try {
    const o = JSON.parse(json);
    if (o && typeof o.done === "object" && o.done) for (const k of Object.keys(o.done)) if (isTutId(k) && Number.isFinite(o.done[k])) st.done[k] = o.done[k];
    if (o && typeof o.skipped === "object" && o.skipped) for (const k of Object.keys(o.skipped)) if (isTutId(k) && o.skipped[k]) st.skipped[k] = true;
    if (o && typeof o.step === "object" && o.step) for (const k of Object.keys(o.step)) if (isTutId(k) && typeof o.step[k] === "string" && isStepId(o.step[k])) st.step[k] = o.step[k];
    if (o && typeof o.ticks === "object" && o.ticks) {
      for (const k of Object.keys(o.ticks)) {
        if (isTutId(k) && Array.isArray(o.ticks[k])) st.ticks[k] = o.ticks[k].filter((x: unknown) => isStepId(x));
      }
    }
  } catch {
    // a corrupt blob reads as a fresh one
  }
  return st;
}

// What the game gets: the finished ids, which were skipped, and the saved step per tutorial.
// A player who was already playing when tutorials arrived (their Basic Training "done" time is the legacy marker 1) is not
// handed the Getting Started checklist either: they have done most of it already and there is no way to tick the rest back.
export function tutorialToClient(st: TutorialState) {
  const done = Object.keys(st.done);
  if (st.done["basic"] === 1 && !st.done["checklist"]) done.push("checklist");
  return { done, skipped: Object.keys(st.skipped), step: st.step, ticks: st.ticks };
}

export function isTutId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9_]{1,24}$/.test(s);
}

export function isStepId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9_]{1,32}$/.test(s);
}
