// Milestone 311: overworld discovery progress. Right now: Memory Wisps, small glowing things hidden around the overworld. Each one
// collected counts toward a lifetime total (it survives relogging and the world re-rolling), and certain totals pay a permanent reward
// once. The game reports each wisp (POST /api/discovery/wisp); the server keeps the count, enforces a pace limit so the number cannot
// be inflated by a hacked client, and says which reward (if any) the new total just earned.
export interface DiscoveryState {
  wisps: number;       // lifetime wisps found
  claimed: number[];   // milestone totals already paid
  day: string;         // UTC day the "today" counter is for
  today: number;       // wisps counted today
  last_at: number;     // ms timestamp of the last wisp (pace limit)
}

// totals that pay out, and what: the game grants the reward only when the server says it is newly earned
export const WISP_MILESTONES: { at: number; reward: string }[] = [
  { at: 5, reward: "crystal" },     // one Knowledge Crystal charge
  { at: 10, reward: "egg_common" }, // a Common Egg
  { at: 20, reward: "hp_flask" },   // +1 health potion charge (max)
  { at: 35, reward: "mp_flask" },   // +1 mana potion charge (max)
  { at: 50, reward: "egg_rare" },   // a Rare Egg
];
export const WISP_REPEAT_EVERY = 25;      // after the last listed one, every 25 more wisps pays a crystal charge
export const WISP_DAILY_CAP = 40;
export const WISP_MIN_GAP_MS = 2500;

export function freshDiscovery(): DiscoveryState {
  return { wisps: 0, claimed: [], day: "", today: 0, last_at: 0 };
}

export function parseDiscovery(json: string | null | undefined): DiscoveryState {
  const st = freshDiscovery();
  if (!json) return st;
  try {
    const o = JSON.parse(json);
    if (Number.isInteger(o.wisps) && o.wisps >= 0) st.wisps = o.wisps;
    if (Array.isArray(o.claimed)) st.claimed = o.claimed.filter((n: unknown) => Number.isInteger(n));
    if (typeof o.day === "string") st.day = o.day.slice(0, 10);
    if (Number.isInteger(o.today) && o.today >= 0) st.today = o.today;
    if (Number.isFinite(o.last_at)) st.last_at = o.last_at;
  } catch {
    // corrupt = fresh
  }
  return st;
}

export function discoveryToClient(st: DiscoveryState) {
  return { wisps: st.wisps, next: nextMilestone(st) };
}

// The next total that pays, and what it pays (for the map's progress line)
export function nextMilestone(st: DiscoveryState): { at: number; reward: string } {
  for (const m of WISP_MILESTONES) if (!st.claimed.includes(m.at)) return m;
  const last = WISP_MILESTONES[WISP_MILESTONES.length - 1].at;
  const k = Math.floor((st.wisps - last) / WISP_REPEAT_EVERY) + 1;
  return { at: last + Math.max(1, k) * WISP_REPEAT_EVERY, reward: "crystal" };
}

// Counts one wisp. Returns { ok, reward } - ok false when the pace limit refuses it.
export function countWisp(st: DiscoveryState, now: number): { ok: boolean; reward: string | null; error?: string } {
  const day = new Date(now).toISOString().slice(0, 10);
  if (st.day !== day) { st.day = day; st.today = 0; }
  if (st.today >= WISP_DAILY_CAP) return { ok: false, reward: null, error: "Daily limit reached" };
  if (now - st.last_at < WISP_MIN_GAP_MS) return { ok: false, reward: null, error: "Too fast" };
  st.today += 1;
  st.last_at = now;
  st.wisps += 1;
  let reward: string | null = null;
  for (const m of WISP_MILESTONES) {
    if (st.wisps >= m.at && !st.claimed.includes(m.at)) { st.claimed.push(m.at); reward = m.reward; break; }
  }
  if (reward === null && st.wisps > WISP_MILESTONES[WISP_MILESTONES.length - 1].at) {
    const last = WISP_MILESTONES[WISP_MILESTONES.length - 1].at;
    const slot = last + Math.floor((st.wisps - last) / WISP_REPEAT_EVERY) * WISP_REPEAT_EVERY;
    if (slot > last && (st.wisps - last) % WISP_REPEAT_EVERY === 0 && !st.claimed.includes(slot)) { st.claimed.push(slot); reward = "crystal"; }
  }
  return { ok: true, reward };
}
