// Mirrors the item struct produced by scr_generate_item() in the
// GameMaker client (scripts/scr_items/scr_items.gml). Keep these two in
// sync by hand for now - there's no shared schema file between the two
// codebases yet.
export interface Item {
  name: string;
  slot: "weapon" | "helmet" | "chest" | "accessory";
  rarity_index: number;
  rarity_name: string;
  color: number;
  item_level: number;
  atk: number;
  hp: number;
  def: number;
  crit: number;
  spd: number;
}

// Milestone 185: character customization (phase 2). Each field names one variant of that
// layer - see appearance_options in scr_appearance.gml on the client for the valid values
// per layer. Kept as a loose Record rather than a strict union so adding a new variant is
// an asset-only change (no client/server type sync needed).
export interface Appearance {
  skin: string;
  hair: string;
  // Milestone 190/191: hair/torso/legs/feet color are client-side shader recolors
  // (scr_hair_color.gml / scr_cloth_color.gml), not separate sprite variants - the server
  // just round-trips the chosen palette name ("" means no color override for that layer).
  hair_color: string;
  torso: string;
  torso_color: string;
  legs: string;
  legs_color: string;
  feet: string;
  feet_color: string;
}

export interface CharacterState {
  level: number;
  xp: number;
  xp_to_level: number;
  base_max_hp: number;
  base_atk_damage: number;
  inventory: Item[];
  storage: Item[]; // Milestone 108: the personal storage chest - same opaque JSON round-trip as inventory
  equipped_weapon: Item | null;
  equipped_helmet: Item | null;
  equipped_chest: Item | null;
  equipped_accessory: Item | null;
  // Milestone 166: last known overworld cell, null until they ever leave town. Only ever set
  // from an overworld/hub arrival (mp_room_goto on the client) - stepping into a dungeon does
  // NOT update these, so they stay pointed at the entrance cell for the whole dungeon run. That
  // makes "resume here on next login" naturally land just outside the dungeon, not town, if
  // that's where they logged out - see fetch_assigned_questions() in scr_login.gml.
  world_x: number | null;
  world_y: number | null;
  appearance: Appearance;
  // Milestone 256: read-only here - Lorekin state is changed through /api/lorekin/*, never the PUT.
  lorekin?: unknown;
  house?: unknown; // Milestone 262: read-only here too - changed through /api/house/*
  tutorial?: unknown; // Milestone 297: read-only here too - changed through /api/tutorial/*
}

export const DEFAULT_APPEARANCE: Appearance = {
  skin: "light",
  hair: "plain_auburn",
  hair_color: "orange",
  torso: "clothes_shortsleeve_tshirt",
  torso_color: "",
  legs: "pants",
  legs_color: "",
  feet: "boots",
  feet_color: "",
};

export const DEFAULT_CHARACTER: CharacterState = {
  level: 1,
  xp: 0,
  xp_to_level: 50,
  base_max_hp: 100,
  base_atk_damage: 12,
  inventory: [],
  storage: [],
  equipped_weapon: null,
  equipped_helmet: null,
  equipped_chest: null,
  equipped_accessory: null,
  world_x: null,
  world_y: null,
  appearance: DEFAULT_APPEARANCE,
};
