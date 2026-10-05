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

export const INCUBATE_MS = 24 * 60 * 60 * 1000;
export const BOOST_MS = 6 * 60 * 60 * 1000; // one Knowledge Crystal charge
export const MAX_COLLECTION = 60;
export const MAX_NAME_LEN = 14;

export interface LorekinEntry {
  id: number;
  species: string;
  name: string;
}

export interface LorekinState {
  list: LorekinEntry[];
  active: number | null;
  next_id: number;
  // ready_at is epoch ms on THIS server's clock; never sent to the client as-is (see toClient).
  incubator: { rarity: number; ready_at: number } | null;
}

export const EMPTY_STATE: LorekinState = { list: [], active: null, next_id: 1, incubator: null };

export function parseState(json: string | null | undefined): LorekinState {
  if (!json) return { ...EMPTY_STATE, list: [] };
  try {
    const s = JSON.parse(json);
    return {
      list: Array.isArray(s.list) ? s.list : [],
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
    list: s.list,
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
      st.list.push({ id: st.next_id, species, name: DEFAULT_NAMES[species] ?? species });
      st.next_id += 1;
      changed = true;
    }
  }
  if (changed && st.active == null && st.list.length > 0) st.active = st.list[0].id;
  return changed;
}
