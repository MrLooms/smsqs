// Milestone 307: the game event log. The game queues small events as things happen and posts them in batches (POST /api/events); this is
// the allowlist and the cleaner for the free-text part. What the events mean:
//   death        detail = where ("world:desert", "dungeon:ice", "boss:lava", "town")
//   level        detail = the new level
//   dungeon_in   detail = biome entered       dungeon_out  detail = biome left (portal or retreat)    boss  detail = biome of the boss beaten
//   craft / enchant / hatch                    detail = what kind (slot, "apply"/"upgrade"/"swap", ...)
//   shop_buy / shop_sell / gold_in / gold_out  n = gold
//   quest_take / quest_done                    detail = quest type
//   panel        detail = which menu was opened (smith, enchant, lorekin, wardrobe, carpenter, shop, storage, house, quests, ...)
export const EVENT_KINDS = [
  "death", "level", "dungeon_in", "dungeon_out", "boss", "craft", "enchant", "hatch",
  "shop_buy", "shop_sell", "gold_in", "gold_out", "quest_take", "quest_done", "panel",
];

// Short lowercase tokens only ("dungeon:desert"): anything else becomes "" so nothing odd is ever stored.
export function cleanDetail(d: unknown): string {
  const s = typeof d === "string" ? d.toLowerCase() : typeof d === "number" ? String(d) : "";
  return /^[a-z0-9_:.\-]{1,40}$/.test(s) ? s : "";
}
