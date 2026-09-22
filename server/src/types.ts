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

export interface CharacterState {
  level: number;
  xp: number;
  xp_to_level: number;
  base_max_hp: number;
  base_atk_damage: number;
  inventory: Item[];
  equipped_weapon: Item | null;
  equipped_helmet: Item | null;
  equipped_chest: Item | null;
  equipped_accessory: Item | null;
}

export const DEFAULT_CHARACTER: CharacterState = {
  level: 1,
  xp: 0,
  xp_to_level: 50,
  base_max_hp: 100,
  base_atk_damage: 12,
  inventory: [],
  equipped_weapon: null,
  equipped_helmet: null,
  equipped_chest: null,
  equipped_accessory: null,
};
