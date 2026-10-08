// Milestone 256: Lorekin (pets). The collection, the active one and the egg incubator live
// server-side (characters.lorekin_json) and are changed ONLY through the /api/lorekin/* routes,
// never by the client's character PUT - that is what makes the 24-hour incubation real (the clock
// is this server's, so changing a Chromebook's date skips nothing) and what lets a hatch pick the
// species here rather than trusting the client. Eggs themselves are ordinary client-side inventory
// items (same trust level as every other item); the client removes one only after /incubate
// succeeds.

// Species ids MUST match scr_lorekin.gml's lorekin_species_table(); indexed by rarity
// (0 Common .. 3 Legendary).
export const SPECIES_BY_RARITY: string[][] = [
  ["chicken", "snake", "panda", "cat", "ferret"],
  ["spider", "crab", "fox", "dragonfly", "golem", "twig"],
  ["ember", "ice", "imp", "satyr", "swamp"],
  ["eyebat", "brain", "kobold"],
];

export const DEFAULT_NAMES: Record<string, string> = {
  chicken: "Chicken", snake: "Snake", panda: "Red Panda", cat: "Cat", ferret: "Ferret",
  spider: "Spider", crab: "Crab", fox: "Fox", dragonfly: "Dragonfly", golem: "Mini Golem", twig: "Twig",
  ember: "Ember", ice: "Iceling", imp: "Imp", satyr: "Satyr", swamp: "Swampling",
  eyebat: "Eyebat", brain: "Brainiac", kobold: "Kobold Mage",
};

// how long an egg takes by rarity: Common 6h, Rare 12h, Epic 18h, Legendary 24h (an egg already incubating keeps its time)
export const incubateMs = (rarity: number) => (Math.max(0, Math.min(3, rarity)) + 1) * 6 * 60 * 60 * 1000;
export const BOOST_MS = 6 * 60 * 60 * 1000; // one Knowledge Crystal charge
export const MAX_COLLECTION = 60;
export const MAX_NAME_LEN = 14;

// ---- Milestone 294: Lorekin LEVEL up. Every Lorekin starts at level 1 and levels from combat XP (the client sends the XP its active
// Lorekin earned; the server turns it into levels with the curve below, so levels are decided here, never trusted from the client).
// The curve is the player's own XP curve times a rarity multiplier - rarer Lorekin are a bigger commitment (and hit harder per level,
// see scr_lorekin.gml). KEEP IN SYNC with lorekin_xp_next() in scr_lorekin.gml (same constants).
export const MAX_LOREKIN_LEVEL = 99;
export const XP_RARITY_MULT = [1.0, 1.4, 1.9, 2.6];

export function rarityOf(species: string): number {
  for (let r = 0; r < SPECIES_BY_RARITY.length; r++) if (SPECIES_BY_RARITY[r].includes(species)) return r;
  return 0;
}

export function xpNext(level: number, rarity: number): number {
  const lv = Math.max(1, Math.min(MAX_LOREKIN_LEVEL, level));
  const base = Math.max(1, Math.round(Math.min(75 * Math.pow(1.35, lv - 1), 15.5 * lv * lv + 31 * lv)));
  return Math.max(1, Math.round(base * XP_RARITY_MULT[Math.max(0, Math.min(3, rarity))]));
}

// Support Lorekin (healers and mana) roll from a different set of natures than attackers; "steady" is in both.
export const SUPPORT_SPECIES = new Set(["cat", "dragonfly", "crab", "satyr"]);
export const NATURES_ATTACK = ["fierce", "swift", "keen", "steady"];
export const NATURES_SUPPORT = ["gentle", "quick", "attentive", "steady"];

export function naturesFor(species: string): string[] {
  return SUPPORT_SPECIES.has(species) ? NATURES_SUPPORT : NATURES_ATTACK;
}

export function rollNature(species: string): string {
  const pool = naturesFor(species);
  return pool[Math.floor(Math.random() * pool.length)];
}

// a stable nature for a Lorekin hatched before natures existed (so repeated reads agree until it is saved)
function defaultNature(id: number, species: string): string {
  const pool = naturesFor(species);
  return pool[(id * 7 + species.length) % pool.length];
}

export interface LorekinEntry {
  id: number;
  species: string;
  name: string;
  level: number;   // 1..99
  xp: number;      // progress into the current level
  nature: string;  // a small personality that tweaks its stats (see scr_lorekin.gml lorekin_nature)
}

// Adds combat XP to one Lorekin, levelling it up as far as the XP goes (stops at the cap).
export function addXp(e: LorekinEntry, amount: number) {
  if (e.level >= MAX_LOREKIN_LEVEL) { e.xp = 0; return; }
  const rarity = rarityOf(e.species);
  e.xp += Math.max(0, Math.floor(amount));
  while (e.level < MAX_LOREKIN_LEVEL) {
    const need = xpNext(e.level, rarity);
    if (e.xp < need) break;
    e.xp -= need;
    e.level += 1;
  }
  if (e.level >= MAX_LOREKIN_LEVEL) e.xp = 0;
}

export function newEntry(id: number, species: string): LorekinEntry {
  return { id, species, name: DEFAULT_NAMES[species] ?? species, level: 1, xp: 0, nature: rollNature(species) };
}

export interface LorekinState {
  list: LorekinEntry[];
  active: number | null;
  next_id: number;
  // ready_at is epoch ms on THIS server's clock; never sent to the client as-is (see toClient).
  // Milestone 318: `species` is set when the egg was of a named species (a tower's trapped Lorekin) - it hatches into exactly that
  incubator: { rarity: number; ready_at: number; species?: string } | null;
}

export const EMPTY_STATE: LorekinState = { list: [], active: null, next_id: 1, incubator: null };

export function parseState(json: string | null | undefined): LorekinState {
  if (!json) return { ...EMPTY_STATE, list: [] };
  try {
    const s = JSON.parse(json);
    const list: LorekinEntry[] = Array.isArray(s.list) ? s.list : [];
    // Lorekin from before levels existed: level 1, no XP, and a stable nature
    for (const e of list) {
      if (!Number.isInteger(e.level) || e.level < 1) e.level = 1;
      if (e.level > MAX_LOREKIN_LEVEL) e.level = MAX_LOREKIN_LEVEL;
      if (!Number.isFinite(e.xp) || e.xp < 0) e.xp = 0;
      if (typeof e.nature !== "string" || !naturesFor(e.species).includes(e.nature)) e.nature = defaultNature(e.id, e.species);
    }
    return {
      list,
      active: typeof s.active === "number" ? s.active : null,
      next_id: typeof s.next_id === "number" ? s.next_id : 1,
      incubator: s.incubator && typeof s.incubator.ready_at === "number" ? s.incubator : null,
    };
  } catch {
    return { ...EMPTY_STATE, list: [] };
  }
}

// What the game receives: the incubator as "seconds left", so the client never needs to agree
// with the server about what time it is.
export function toClient(s: LorekinState) {
  const now = Date.now();
  return {
    // each entry also carries xp_next (what it needs for its next level) so the game never has to agree with the curve to draw a bar
    list: s.list.map((e) => ({ ...e, xp_next: e.level >= MAX_LOREKIN_LEVEL ? 0 : xpNext(e.level, rarityOf(e.species)) })),
    active: s.active,
    incubator: s.incubator
      ? { rarity: s.incubator.rarity, ready_in_s: Math.max(0, Math.ceil((s.incubator.ready_at - now) / 1000)) }
      : null,
  };
}

export function pickSpecies(rarity: number): string {
  const pool = SPECIES_BY_RARITY[rarity];
  return pool[Math.floor(Math.random() * pool.length)];
}

// Letters, digits, spaces, apostrophes and hyphens only; trimmed and collapsed. Returns null when
// the name is unusable (the caller also runs isUsernameAllowed on it).
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[^A-Za-z0-9 '\-]/g, "").replace(/\s+/g, " ").trim();
  if (s.length < 1 || s.length > MAX_NAME_LEN) return null;
  return s;
}

// Testing aid: make sure a state holds at least one of EVERY species (used for the "test" account on
// login). Returns true if it added anything. Never removes or renames what's there.
export function fillAllSpecies(st: LorekinState): boolean {
  let changed = false;
  for (const pool of SPECIES_BY_RARITY) {
    for (const species of pool) {
      if (st.list.some((e) => e.species === species)) continue;
      st.list.push(newEntry(st.next_id, species));
      st.next_id += 1;
      changed = true;
    }
  }
  if (changed && st.active == null && st.list.length > 0) st.active = st.list[0].id;
  return changed;
}
