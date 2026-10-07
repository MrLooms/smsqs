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
}

export function freshTutorial(): TutorialState {
  return { done: {}, skipped: {}, step: {} };
}

export function parseTutorial(json: string | null | undefined): TutorialState {
  const st = freshTutorial();
  if (!json) return st;
  try {
    const o = JSON.parse(json);
    if (o && typeof o.done === "object" && o.done) for (const k of Object.keys(o.done)) if (isTutId(k) && Number.isFinite(o.done[k])) st.done[k] = o.done[k];
    if (o && typeof o.skipped === "object" && o.skipped) for (const k of Object.keys(o.skipped)) if (isTutId(k) && o.skipped[k]) st.skipped[k] = true;
    if (o && typeof o.step === "object" && o.step) for (const k of Object.keys(o.step)) if (isTutId(k) && typeof o.step[k] === "string" && isStepId(o.step[k])) st.step[k] = o.step[k];
  } catch {
    // a corrupt blob reads as a fresh one
  }
  return st;
}

// What the game gets: the finished ids, which were skipped, and the saved step per tutorial.
export function tutorialToClient(st: TutorialState) {
  return { done: Object.keys(st.done), skipped: Object.keys(st.skipped), step: st.step };
}

export function isTutId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9_]{1,24}$/.test(s);
}

export function isStepId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9_]{1,32}$/.test(s);
}
