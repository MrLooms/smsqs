// Milestone 311 (reworked in 312): overworld discovery progress. Right now: Memory Wisps, small glowing things hidden around the
// overworld. Each one collected is CARRIED (held) until the player trades them in to the Wisp Keeper NPC in town, who pays a flat
// amount of gold for each. The server keeps the carried count and the lifetime total, enforces a pace limit so the number cannot be
// inflated by a hacked client, and does the trade (so a wisp can only be paid for once).
export interface DiscoveryState {
  held: number;        // wisps carried, not yet traded in
  lifetime: number;    // wisps ever found
  day: string;         // UTC day the "today" counter is for
  today: number;       // wisps counted today
  last_at: number;     // ms timestamp of the last wisp (pace limit)
}

export const WISP_GOLD = 100;            // paid per wisp
export const WISP_DAILY_CAP = 30;        // wisps counted per UTC day
export const WISP_MIN_GAP_MS = 2500;

export function freshDiscovery(): DiscoveryState {
  return { held: 0, lifetime: 0, day: "", today: 0, last_at: 0 };
}

export function parseDiscovery(json: string | null | undefined): DiscoveryState {
  const st = freshDiscovery();
  if (!json) return st;
  try {
    const o = JSON.parse(json);
    // (an older save kept just "wisps": that was the lifetime total)
    const life = Number.isInteger(o.lifetime) ? o.lifetime : (Number.isInteger(o.wisps) ? o.wisps : 0);
    if (life >= 0) st.lifetime = life;
    if (Number.isInteger(o.held) && o.held >= 0) st.held = o.held;
    if (typeof o.day === "string") st.day = o.day.slice(0, 10);
    if (Number.isInteger(o.today) && o.today >= 0) st.today = o.today;
    if (Number.isFinite(o.last_at)) st.last_at = o.last_at;
  } catch {
    // corrupt = fresh
  }
  return st;
}

export function discoveryToClient(st: DiscoveryState) {
  return { held: st.held, lifetime: st.lifetime, gold_each: WISP_GOLD };
}

// Counts one wisp as carried. ok false when the pace limit refuses it.
export function countWisp(st: DiscoveryState, now: number): { ok: boolean; error?: string } {
  const day = new Date(now).toISOString().slice(0, 10);
  if (st.day !== day) { st.day = day; st.today = 0; }
  if (st.today >= WISP_DAILY_CAP) return { ok: false, error: "Daily limit reached" };
  if (now - st.last_at < WISP_MIN_GAP_MS) return { ok: false, error: "Too fast" };
  st.today += 1;
  st.last_at = now;
  st.held += 1;
  st.lifetime += 1;
  return { ok: true };
}

// Trades every carried wisp for gold. Returns how many and how much.
export function tradeWisps(st: DiscoveryState): { n: number; gold: number } {
  const n = st.held;
  st.held = 0;
  return { n, gold: n * WISP_GOLD };
}
