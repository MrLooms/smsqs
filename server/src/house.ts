// Milestone 262: the player home. One house per account, changed ONLY through /api/house/* (never the
// character PUT), so the server - not the client - decides what you own and what fits. Coordinates are
// relative to the house's top-left corner; the client builds the room from them (scr_house.gml).
import { HOUSE_ITEM_IDS, HOUSE_VARIANT_OF, HOUSE_VARIANT_COUNT, HOUSE_EXTRA_FLOORS, HOUSE_EXTRA_WALLS } from "./houseCatalog";

// Milestone 313: after the originals come the floors / walls cut from the furniture packs (generated into houseCatalog.ts)
export const FLOORS = ["stone_brown", "brick_red", "stone_grey", "checker_tan", ...HOUSE_EXTRA_FLOORS];
// wall paint (the client tints the brick wall face): see interior_wall_color in scr_interiors.gml
export const WALLS = ["brick", "slate", "sand", "moss", "plum", ...HOUSE_EXTRA_WALLS];

// Interior size (px) and how many pieces fit, by house tier. The client mirrors w/h (home_tier_info).
export const TIERS = [
  { w: 640, h: 520, max: 16 },
  { w: 800, h: 600, max: 32 },
  { w: 960, h: 680, max: 56 },
];

export interface Placed {
  item: string;
  x: number;
  y: number;
  flip: number;
  v: number; // which variant of the item (Milestone 281: a group of look-alikes is one item the player cycles through)
}

export interface HouseState {
  tier: number;
  floor: string;
  wall: string;
  owned: Record<string, number>;
  placed: Placed[];
  chest: { x: number; y: number }; // where the storage chest stands (movable, never deletable)
  v: number; // layout version; < 2 = the short-lived starter pack was granted (cleared on first read); < 3 = partitions in the old shape (migrated)
}

const ITEM_SET = new Set(HOUSE_ITEM_IDS);

// Milestone 313: partitions used to be one catalog group per PAINT with the SHAPE as the variant (v 0-3 = across 1-4, 4-7 = up 1-4); they are
// now one group per SHAPE with the PAINT as the variant. A house saved the old way (v < 3) has its walls converted when it is first read.
const OLD_PAINTS = ["brick", "slate", "sand", "moss", "plum", "stone"];
function migratePartition(pl: any): any {
  const m = pl && typeof pl.item === "string" ? /^wall_([a-z]+)_h1$/.exec(pl.item) : null;
  if (!m) return pl;
  const paint = OLD_PAINTS.indexOf(m[1]);
  if (paint < 0) return pl;
  const oldV = Number.isInteger(pl.v) && pl.v >= 0 && pl.v < 8 ? pl.v : 0;
  return { ...pl, item: "wall_brick_" + (oldV < 4 ? "h" : "v") + ((oldV % 4) + 1), v: paint };
}

// A new home owns NOTHING - every piece is bought from the Carpenter (or won). The "test" account is the
// exception: it owns plenty of every piece, including ones added to the catalog later.
export const MAX_OWNED_PER_ITEM = 99;

export const DEFAULT_CHEST = { x: 570, y: 150 };

// Milestone 272: partitions ("wall_*") are free for everyone: unlimited, never bought, and they don't use up the
// house's piece cap - they have a cap of their own so a layout stays a sane size.
export const MAX_PARTITIONS = 150;
export const isFreeItem = (id: string) => id.startsWith("wall_");

export function defaultHouse(): HouseState {
  return { tier: 0, floor: "stone_brown", wall: "brick", owned: {}, placed: [], chest: { ...DEFAULT_CHEST }, v: 3 };
}

// Returns the parsed state and whether parsing had to ADD something (the starter pack, the test
// account's everything) - the caller saves it back when so.
export function parseHouse(json: string | null | undefined, isTest: boolean): { state: HouseState; changed: boolean } {
  let s = defaultHouse();
  try {
    const p = json ? JSON.parse(json) : {};
    s = {
      tier: Number.isInteger(p.tier) && p.tier >= 0 && p.tier < TIERS.length ? p.tier : 0,
      floor: FLOORS.includes(p.floor) ? p.floor : "stone_brown",
      wall: WALLS.includes(p.wall) ? p.wall : "brick",
      owned: p.owned && typeof p.owned === "object" ? p.owned : {},
      placed: Array.isArray(p.placed) ? p.placed : [],
      chest: p.chest && Number.isFinite(p.chest.x) && Number.isFinite(p.chest.y) ? { x: Math.round(p.chest.x), y: Math.round(p.chest.y) } : { ...DEFAULT_CHEST },
      v: Number.isInteger(p.v) ? p.v : 1,
    };
  } catch {
    /* fall back to the default */
  }
  let changed = false;
  if (s.v < 3) {
    // Milestone 313: old-format partitions become the new shape groups - BEFORE the variant fold below, which would read their ids differently
    s.placed = s.placed.map(migratePartition);
    changed = true;
  }
  // Milestone 281: houses saved before furniture was grouped hold ids of individual variants - fold them into their group
  // (owned counts add up, capped; a placed piece becomes the group's id plus its variant index).
  for (const id of Object.keys(s.owned)) {
    const g = HOUSE_VARIANT_OF[id];
    if (!g) continue;
    s.owned[g[0]] = Math.min(MAX_OWNED_PER_ITEM, (s.owned[g[0]] ?? 0) + (Number(s.owned[id]) || 0));
    delete s.owned[id];
    changed = true;
  }
  s.placed = s.placed.map((pl) => {
    const g = pl && typeof pl.item === "string" ? HOUSE_VARIANT_OF[pl.item] : undefined;
    if (g) { changed = true; return { ...pl, item: g[0], v: g[1] }; }
    return pl;
  });
  if (s.v < 2) {
    // an earlier build granted a starter pack; nothing has been purchasable until now, so wipe it
    s.owned = {};
    s.placed = [];
    s.v = 3;
    changed = true;
  }
  if (s.v < 3) {
    s.v = 3;
    changed = true;
  }
  if (isTest) {
    // the "test" account owns plenty of everything, always
    for (const id of HOUSE_ITEM_IDS) {
      if (isFreeItem(id)) continue;
      if ((s.owned[id] ?? 0) < 10) { s.owned[id] = 10; changed = true; }
    }
  }
  return { state: s, changed };
}

// Checks a layout the client wants to save against what the account owns and what fits. Returns the
// cleaned list, or an error message.
export function cleanPlaced(s: HouseState, raw: unknown): Placed[] | string {
  if (!Array.isArray(raw)) return "Bad layout";
  const t = TIERS[s.tier];
  const out: Placed[] = [];
  const used: Record<string, number> = {};
  let pieces = 0;
  let partitions = 0;
  for (const r of raw) {
    if (!r || typeof r.item !== "string" || !ITEM_SET.has(r.item)) return "Unknown furniture";
    const x = Math.round(Number(r.x));
    const y = Math.round(Number(r.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "Bad position";
    if (x < 20 || x > t.w - 20 || y < 60 || y > t.h - 20) return "A piece is outside the room";
    used[r.item] = (used[r.item] ?? 0) + 1;
    if (isFreeItem(r.item)) {
      partitions += 1;
      if (partitions > MAX_PARTITIONS) return "That's a lot of walls - the most you can build is " + MAX_PARTITIONS;
    } else {
      pieces += 1;
      if (pieces > t.max) return "Too many pieces for this house";
      if (used[r.item] > (s.owned[r.item] ?? 0)) return "You don't own that many";
    }
    const count = HOUSE_VARIANT_COUNT[r.item] ?? 1;
    const v = Number.isInteger(r.v) && r.v >= 0 && r.v < count ? r.v : 0;
    out.push({ item: r.item, x, y, flip: r.flip ? 1 : 0, v });
  }
  return out;
}

// A chest position from the client, checked against the room; returns the cleaned point or an error message.
export function cleanChest(s: HouseState, raw: unknown): { x: number; y: number } | string {
  const r = raw as { x?: unknown; y?: unknown } | null;
  if (!r) return "Bad chest position";
  const x = Math.round(Number(r.x));
  const y = Math.round(Number(r.y));
  const t = TIERS[s.tier];
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 20 || x > t.w - 20 || y < 60 || y > t.h - 20) return "The chest is outside the room";
  return { x, y };
}

export function houseToClient(s: HouseState) {
  return { tier: s.tier, floor: s.floor, wall: s.wall, chest: s.chest, owned: s.owned, placed: s.placed, max: TIERS[s.tier].max, w: TIERS[s.tier].w, h: TIERS[s.tier].h };
}
