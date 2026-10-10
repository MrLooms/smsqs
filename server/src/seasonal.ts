// Milestone 347: SEASONAL EVENTS - the Halloween "Haunted Hollow" event (Oct 25 - Oct 31, 2026, Vancouver time).
// A temporary NPC in the hub (Madam Hex) gives 3 spooky daily quests; finishing ANY one pays one random Treat Bag a day (a cosmetic prize, never one the
// student already owns while there are others left, gold when the whole pool is owned). Enemies also drop Candy, which buys a CHOSEN piece at fixed prices.
// The game reports progress in batches (counters, never "I finished"); the server keeps the day's counters, the candy balance and what was claimed, and is
// the only place that adds a cosmetic to the account. The test accounts see the event active at any time (so it can be tried before the 25th).
import { dbGet, dbRun, withTransaction } from "./db";
import { COSMETIC_IDS } from "./cosmeticCatalog";
import { parseHouse, MAX_OWNED_PER_ITEM } from "./house";
import { HOUSE_ITEM_IDS } from "./houseCatalog";

export const SEASON_ID = "halloween_2026";
export const SEASON_NAME = "Haunted Hollow";
const TZ = "America/Vancouver";
const START_MS = Date.parse("2026-10-25T00:00:00-07:00");
const END_MS = Date.parse("2026-10-31T23:59:59-07:00") + 999;
const BAG_GOLD = 150;          // the Treat Bag's prize once the whole pool is owned

// ---------------------------------------------------------------- the quests (3 a day: one from each group, picked by the day)
interface QuestDef { id: string; title: string; desc: string; kind: string; target: number; candy: number; }
const GROUP_A: QuestDef[] = [
  { id: "ghoul", title: "Ghoul Hunt", desc: "Defeat 20 monsters", kind: "kills", target: 20, candy: 25 },
  { id: "horde", title: "Graveyard Shift", desc: "Defeat 40 monsters", kind: "kills", target: 40, candy: 45 },
];
const GROUP_B: QuestDef[] = [
  { id: "champ", title: "Champion Hunt", desc: "Defeat a champion", kind: "champions", target: 1, candy: 40 },
  { id: "tower", title: "Tower Raid", desc: "Clear a tower", kind: "towers", target: 1, candy: 60 },
  { id: "wisp", title: "Wisp Whisperer", desc: "Find a Memory Wisp", kind: "wisps", target: 1, candy: 30 },
];
const GROUP_C: QuestDef[] = [
  { id: "exam5", title: "Haunted Exam", desc: "Answer 5 questions correctly", kind: "questions", target: 5, candy: 30 },
  { id: "exam10", title: "Spooky Study Hall", desc: "Answer 10 questions correctly", kind: "questions", target: 10, candy: 55 },
];
const KINDS = ["kills", "champions", "towers", "wisps", "questions"];
// the most one batch of progress may add (the game sends them every few seconds)
const CAPS: Record<string, number> = { kills: 80, champions: 10, towers: 3, wisps: 5, questions: 40, candy: 250 };

// ---------------------------------------------------------------- the prizes
export interface Prize { id: string; weight: number; price: number; tier: "legendary" | "epic" | "rare" | "common"; kind: "cosmetic" | "furniture"; }
// Tiers: one price (candy) each - furniture costs what a costume of the same tier costs - and a SHARE of the bag: of every 100 bags (while nothing is owned
// yet) about 3 give a legendary piece, 12 an epic, 25 a rare and 60 a common. The share is split evenly over the tier's pieces, so a tier with more pieces
// gives each one a smaller weight. (As a student owns cosmetics those leave their tier's pool and the odds shift to what is left.)
const TIER_INFO: Record<Prize["tier"], { share: number; price: number }> = {
  legendary: { share: 3, price: 1200 },
  epic: { share: 12, price: 400 },
  rare: { share: 25, price: 200 },
  common: { share: 60, price: 120 },
};
function buildPool(): Prize[] {
  const have = new Set(COSMETIC_IDS);
  const homeIds = new Set(HOUSE_ITEM_IDS);
  const out: Prize[] = [];
  const seen = new Set<string>();
  const add = (id: string, tier: Prize["tier"], kind: Prize["kind"]) => {
    if (seen.has(id)) return;
    if (kind === "cosmetic" ? !have.has(id) : !homeIds.has(id)) return;
    seen.add(id);
    out.push({ id, tier, kind, weight: 0, price: TIER_INFO[tier].price });
  };
  // LEGENDARY: Bat Wings, the Angel Statue and the Coffin
  add("wings_wings_bat", "legendary", "cosmetic");
  for (const id of ["ff_gra_34", "ff_gra_36"]) add(id, "legendary", "furniture");
  // EPIC: the six Halloween heads, Lizard Wings, the Tombstone and the Cross
  for (const id of ["mask_heads_jack", "mask_heads_skeleton", "mask_heads_zombie", "mask_heads_vampire", "mask_heads_frankenstein", "mask_heads_wartotaur", "wings_wings_lizard_alt"]) add(id, "epic", "cosmetic");
  for (const id of ["ff_gra_23", "ff_gra_16"]) add(id, "epic", "furniture");
  // RARE: the other creature heads
  for (const id of COSMETIC_IDS) if (id.startsWith("mask_")) add(id, "rare", "cosmetic");
  // COMMON: everything else - horns, ears, a hood, a top hat, a tail; and the small graveyard furniture
  for (const id of COSMETIC_IDS) if (id.startsWith("horns_")) add(id, "common", "cosmetic");
  for (const id of ["ears_ears_cat", "ears_ears_wolf", "hat_cloth_hood_sack", "hat_formal_tophat", "tail_tail_lizard_alt"]) add(id, "common", "cosmetic");
  // (the fence pillar, grave plot, weeds, dead tree and iron fence are not part of the event)
  for (const id of ["ff_gra_41", "ff_gra_56", "ff_gra_59", "ff_gra_46", "ff_gra_67", "ff_gra_73", "ff_gra_97", "ff_gra_54"]) add(id, "common", "furniture");
  // each piece's weight = its tier's share / how many pieces the tier has
  for (const t of Object.keys(TIER_INFO) as Prize["tier"][]) {
    const inTier = out.filter((p) => p.tier === t);
    for (const p of inTier) p.weight = TIER_INFO[t].share / inTier.length;
  }
  return out;
}
const POOL: Prize[] = buildPool();
const POOL_BY_ID = new Map(POOL.map((p) => [p.id, p]));

async function houseOwnedCounts(userId: number, forced: boolean): Promise<Record<string, number>> {
  const row = await dbGet<{ house_json: string | null }>("SELECT house_json FROM characters WHERE user_id = ?", [userId]);
  try { return parseHouse(row?.house_json ?? null, forced).state.owned ?? {}; } catch { return {}; }
}

// +1 of a furniture piece in the student's home (locked read-modify-write like the Carpenter's route)
async function grantFurniture(userId: number, id: string, forced: boolean): Promise<string | null> {
  return withTransaction(async (query) => {
    const r = await query("SELECT house_json FROM characters WHERE user_id = ? FOR UPDATE", [userId]);
    const { state } = parseHouse(r.rows[0]?.house_json, forced);
    if ((state.owned[id] ?? 0) >= MAX_OWNED_PER_ITEM) return "You already own plenty of those";
    state.owned[id] = (state.owned[id] ?? 0) + 1;
    await query("UPDATE characters SET house_json = ? WHERE user_id = ?", [JSON.stringify(state), userId]);
    return null;
  });
}

// ---------------------------------------------------------------- state
interface DayState { prog: Record<string, number>; done: Record<string, boolean>; bag: boolean; drop: number; }
interface SeasonState { candy: number; bags: number; days: Record<string, DayState>; }

function emptyDay(): DayState { return { prog: {}, done: {}, bag: false, drop: 0 }; }

function parseState(json: string | null): SeasonState {
  try {
    const s = json ? JSON.parse(json) : {};
    return { candy: Math.max(0, Number(s.candy) || 0), bags: Math.max(0, Number(s.bags) || 0), days: (s.days && typeof s.days === "object") ? s.days : {} };
  } catch { return { candy: 0, bags: 0, days: {} }; }
}

async function loadState(userId: number): Promise<SeasonState> {
  const row = await dbGet<{ state_json: string }>("SELECT state_json FROM season_state WHERE user_id = ? AND event_id = ?", [userId, SEASON_ID]);
  return parseState(row?.state_json ?? null);
}

async function saveState(userId: number, st: SeasonState): Promise<void> {
  // keep the days object small: only the last 10 days
  const keys = Object.keys(st.days).sort();
  while (keys.length > 10) delete st.days[keys.shift()!];
  const json = JSON.stringify(st);
  const row = await dbGet<{ user_id: number }>("SELECT user_id FROM season_state WHERE user_id = ? AND event_id = ?", [userId, SEASON_ID]);
  if (row) await dbRun("UPDATE season_state SET state_json = ? WHERE user_id = ? AND event_id = ?", [json, userId, SEASON_ID]);
  else await dbRun("INSERT INTO season_state (user_id, event_id, state_json) VALUES (?, ?, ?)", [userId, SEASON_ID, json]);
}

async function loadOwned(userId: number): Promise<string[]> {
  const row = await dbGet<{ cosmetics_json: string | null }>("SELECT cosmetics_json FROM characters WHERE user_id = ?", [userId]);
  try { return row?.cosmetics_json ? (JSON.parse(row.cosmetics_json) as string[]) : []; } catch { return []; }
}

async function addCosmetic(userId: number, owned: string[], id: string): Promise<string[]> {
  if (!owned.includes(id)) owned.push(id);
  await dbRun("UPDATE characters SET cosmetics_json = ? WHERE user_id = ?", [JSON.stringify(owned), userId]);
  return owned;
}

// ---------------------------------------------------------------- the clock
function dayKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function questsFor(day: string): QuestDef[] {
  const h = hashStr(day);
  return [GROUP_A[h % GROUP_A.length], GROUP_B[(h >> 3) % GROUP_B.length], GROUP_C[(h >> 6) % GROUP_C.length]];
}

export function isSeasonActive(nowMs: number, forced: boolean): boolean {
  return forced || (nowMs >= START_MS && nowMs <= END_MS);
}

// ---------------------------------------------------------------- the payload the game shows
async function payload(userId: number, st: SeasonState, owned: string[], forced: boolean, nowMs: number, extra: Record<string, unknown> = {}) {
  if (!isSeasonActive(nowMs, forced)) return { ok: true, active: false, ...extra };
  const day = dayKey(nowMs);
  const ds = st.days[day] ?? emptyDay();
  const homeOwned = await houseOwnedCounts(userId, forced);
  const qs = questsFor(day).map((q) => ({
    id: q.id, title: q.title, desc: q.desc, target: q.target, candy: q.candy,
    progress: Math.min(q.target, ds.prog[q.kind] ?? 0), done: !!ds.done[q.id],
  }));
  const anyDone = qs.some((q) => q.done);
  return {
    ok: true, active: true,
    event: { id: SEASON_ID, name: SEASON_NAME },
    now_ms: nowMs, ends_ms: forced && nowMs > END_MS ? nowMs + 7 * 86400000 : END_MS,
    day, quests: qs,
    bag_ready: anyDone && !ds.bag, bag_claimed: ds.bag,
    candy: st.candy,
    shop: POOL.map((p) => (p.kind === "furniture"
      ? { id: p.id, price: p.price, tier: p.tier, kind: "furniture", owned: false, own: homeOwned[p.id] ?? 0 }
      : { id: p.id, price: p.price, tier: p.tier, kind: "cosmetic", owned: owned.includes(p.id), own: owned.includes(p.id) ? 1 : 0 })),
    cosmetics: owned,
    ...extra,
  };
}

// ---------------------------------------------------------------- the four calls
export async function seasonGet(userId: number, forced: boolean) {
  const now = Date.now();
  const st = await loadState(userId);
  const owned = await loadOwned(userId);
  return payload(userId, st, owned, forced, now);
}

// body.deltas: counters the game saw since its last report ({ kills, champions, towers, wisps, questions, candy })
export async function seasonProgress(userId: number, forced: boolean, deltas: Record<string, unknown>) {
  const now = Date.now();
  if (!isSeasonActive(now, forced)) return seasonGet(userId, forced);
  const st = await loadState(userId);
  const owned = await loadOwned(userId);
  const day = dayKey(now);
  const ds = st.days[day] ?? (st.days[day] = emptyDay());
  for (const k of KINDS) {
    const n = Math.max(0, Math.min(CAPS[k], Math.floor(Number(deltas?.[k]) || 0)));
    if (n > 0) ds.prog[k] = (ds.prog[k] ?? 0) + n;
  }
  const candy = Math.max(0, Math.min(CAPS.candy, Math.floor(Number(deltas?.candy) || 0)));
  ds.drop += candy;
  st.candy += candy;
  // a quest that just reached its target pays its candy (once)
  for (const q of questsFor(day)) {
    if (!ds.done[q.id] && (ds.prog[q.kind] ?? 0) >= q.target) {
      ds.done[q.id] = true;
      st.candy += q.candy;
    }
  }
  await saveState(userId, st);
  return payload(userId, st, owned, forced, now);
}

// Opens today's Treat Bag.
export async function seasonBag(userId: number, forced: boolean) {
  const now = Date.now();
  const st = await loadState(userId);
  let owned = await loadOwned(userId);
  if (!isSeasonActive(now, forced)) return { ...(await payload(userId, st, owned, forced, now)), ok: false, error: "The event is not on" };
  const day = dayKey(now);
  const ds = st.days[day] ?? (st.days[day] = emptyDay());
  if (ds.bag) return { ...(await payload(userId, st, owned, forced, now)), ok: false, error: "You already opened today's bag - come back tomorrow" };
  if (!Object.values(ds.done).some(Boolean)) return { ...(await payload(userId, st, owned, forced, now)), ok: false, error: "Finish one of today's quests first" };
  // a weighted pick among the cosmetics not owned yet and the furniture (which can come again and again); gold only if nothing is left / the home is full
  const left = POOL.filter((p) => p.kind === "furniture" || !owned.includes(p.id));
  let prize: { id?: string; kind?: string; gold?: number };
  if (left.length === 0) {
    prize = { gold: BAG_GOLD };
  } else {
    let total = 0;
    for (const p of left) total += p.weight;
    let r = Math.random() * total;
    let pick = left[left.length - 1];
    for (const p of left) { r -= p.weight; if (r <= 0) { pick = p; break; } }
    if (pick.kind === "furniture") {
      const err = await grantFurniture(userId, pick.id, forced);
      prize = err ? { gold: BAG_GOLD } : { id: pick.id, kind: "furniture" };
    } else {
      owned = await addCosmetic(userId, owned, pick.id);
      prize = { id: pick.id, kind: "cosmetic" };
    }
  }
  ds.bag = true;
  st.bags += 1;
  await saveState(userId, st);
  return payload(userId, st, owned, forced, now, { prize });
}

// Buys one chosen piece with candy.
export async function seasonBuy(userId: number, forced: boolean, id: string) {
  const now = Date.now();
  const st = await loadState(userId);
  let owned = await loadOwned(userId);
  const fail = async (error: string) => ({ ...(await payload(userId, st, owned, forced, now)), ok: false, error });
  if (!isSeasonActive(now, forced)) return fail("The event is not on");
  const p = POOL_BY_ID.get(id);
  if (!p) return fail("That is not for sale");
  if (st.candy < p.price) return fail("Not enough candy");
  if (p.kind === "furniture") {
    const err = await grantFurniture(userId, id, forced);
    if (err) return fail(err);
  } else {
    if (owned.includes(id)) return fail("You already own that");
    owned = await addCosmetic(userId, owned, id);
  }
  st.candy -= p.price;
  await saveState(userId, st);
  return payload(userId, st, owned, forced, now, { bought: id });
}
