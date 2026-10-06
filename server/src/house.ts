// Milestone 262: the player home. One house per account, changed ONLY through /api/house/* (never the
// character PUT), so the server - not the client - decides what you own and what fits. Coordinates are
// relative to the house's top-left corner; the client builds the room from them (scr_house.gml).
import { HOUSE_ITEM_IDS } from "./houseCatalog";

export const FLOORS = ["stone_brown", "brick_red", "stone_grey", "checker_tan"];
// wall paint (the client tints the brick wall face): see interior_wall_color in scr_interiors.gml
export const WALLS = ["brick", "slate", "sand", "moss", "plum"];

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
}

export interface HouseState {
  tier: number;
  floor: string;
  wall: string;
  owned: Record<string, number>;
  placed: Placed[];
  v: number; // layout version; < 2 means the short-lived starter pack was granted - cleared on first read
}

const ITEM_SET = new Set(HOUSE_ITEM_IDS);

// A new home owns NOTHING - every piece is bought from the Carpenter (or won). The "test" account is the
// exception: it owns plenty of every piece, including ones added to the catalog later.
export const MAX_OWNED_PER_ITEM = 99;

export function defaultHouse(): HouseState {
  return { tier: 0, floor: "stone_brown", wall: "brick", owned: {}, placed: [], v: 2 };
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
      v: Number.isInteger(p.v) ? p.v : 1,
    };
  } catch {
    /* fall back to the default */
  }
  let changed = false;
  if (s.v < 2) {
    // an earlier build granted a starter pack; nothing has been purchasable until now, so wipe it
    s.owned = {};
    s.placed = [];
    s.v = 2;
    changed = true;
  }
  if (isTest) {
    // the "test" account owns plenty of everything, always
    for (const id of HOUSE_ITEM_IDS) {
      if ((s.owned[id] ?? 0) < 10) { s.owned[id] = 10; changed = true; }
    }
    if (s.tier < TIERS.length - 1) { s.tier = TIERS.length - 1; changed = true; }
  }
  return { state: s, changed };
}

// Checks a layout the client wants to save against what the account owns and what fits. Returns the
// cleaned list, or an error message.
export function cleanPlaced(s: HouseState, raw: unknown): Placed[] | string {
  if (!Array.isArray(raw)) return "Bad layout";
  const t = TIERS[s.tier];
  if (raw.length > t.max) return "Too many pieces for this house";
  const out: Placed[] = [];
  const used: Record<string, number> = {};
  for (const r of raw) {
    if (!r || typeof r.item !== "string" || !ITEM_SET.has(r.item)) return "Unknown furniture";
    const x = Math.round(Number(r.x));
    const y = Math.round(Number(r.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "Bad position";
    if (x < 20 || x > t.w - 20 || y < 60 || y > t.h - 20) return "A piece is outside the room";
    used[r.item] = (used[r.item] ?? 0) + 1;
    if (used[r.item] > (s.owned[r.item] ?? 0)) return "You don't own that many";
    out.push({ item: r.item, x, y, flip: r.flip ? 1 : 0 });
  }
  return out;
}

export function houseToClient(s: HouseState) {
  return { tier: s.tier, floor: s.floor, wall: s.wall, owned: s.owned, placed: s.placed, max: TIERS[s.tier].max, w: TIERS[s.tier].w, h: TIERS[s.tier].h };
}
