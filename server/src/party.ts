// In-memory only, on purpose (Milestone 13): parties are a live-session
// concept, not a saved one - nobody needs to rejoin a party after a
// server restart, so there's no table for this in db.ts.

const PARTY_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const MAX_PARTY_SIZE = 4;

export interface PartyMember {
  connId: string;
  userId: number;
  username: string;
  x: number;
  y: number;
  facing: number;
  // Milestone 34 (split-party overworld): which room this member is
  // currently in, as the CLIENT defines it (an opaque string - the server
  // never interprets it, see mp_room_key in scr_multiplayer.gml), the
  // specific room resource they loaded for it, and a party-wide sequence
  // number stamped when they entered this key - lower means in it longer.
  roomKey: string;
  roomAsset: string;
  roomSince: number;
}

export interface Party {
  code: string;
  hostConnId: string;
  members: Map<string, PartyMember>;
  roomSeq: number;
}

const parties = new Map<string, Party>();
const memberParty = new Map<string, string>(); // connId -> party code

function generatePartyCode(): string {
  let attempt = "";
  for (let tries = 0; tries < 20; tries++) {
    attempt = "";
    for (let i = 0; i < 4; i++) {
      attempt += PARTY_CODE_CHARS[Math.floor(Math.random() * PARTY_CODE_CHARS.length)];
    }
    if (!parties.has(attempt)) return attempt;
  }
  throw new Error("Could not generate a unique party code");
}

export function getParty(code: string): Party | undefined {
  return parties.get(code);
}

export function partyOf(connId: string): Party | undefined {
  const code = memberParty.get(connId);
  return code ? parties.get(code) : undefined;
}

// Always succeeds - silently removes a member who isn't in any party. If
// the departing member was host, promotes whoever's been in the party
// longest (Map iteration order = insertion order). Empty party is deleted.
export function leaveParty(connId: string): Party | undefined {
  const party = partyOf(connId);
  if (!party) return undefined;

  party.members.delete(connId);
  memberParty.delete(connId);

  if (party.members.size === 0) {
    parties.delete(party.code);
    return undefined;
  }

  if (party.hostConnId === connId) {
    party.hostConnId = party.members.keys().next().value!;
  }

  return party;
}

export function createParty(connId: string, userId: number, username: string): Party {
  leaveParty(connId);

  const code = generatePartyCode();
  const party: Party = { code, hostConnId: connId, members: new Map(), roomSeq: 0 };
  party.members.set(connId, { connId, userId, username, x: 0, y: 0, facing: 0, roomKey: "", roomAsset: "", roomSince: 0 });
  parties.set(code, party);
  memberParty.set(connId, code);
  return party;
}

export function joinParty(
  connId: string,
  userId: number,
  username: string,
  code: string
): { party: Party } | { error: string } {
  const party = parties.get(code.trim().toUpperCase());
  if (!party) return { error: "No party with that code" };
  if (party.members.size >= MAX_PARTY_SIZE) return { error: "That party is full" };

  leaveParty(connId);
  party.members.set(connId, { connId, userId, username, x: 0, y: 0, facing: 0, roomKey: "", roomAsset: "", roomSince: 0 });
  memberParty.set(connId, party.code);
  return { party };
}

export function updatePosition(connId: string, x: number, y: number, facing: number): Party | undefined {
  const party = partyOf(connId);
  const member = party?.members.get(connId);
  if (!party || !member) return undefined;

  member.x = x;
  member.y = y;
  member.facing = facing;
  return party;
}

// Milestone 34: records which room a member just entered. Re-announcing the
// SAME key (e.g. after being corrected onto the room resource someone
// already in it loaded) keeps their original roomSince - only actually
// changing rooms counts as a new arrival.
export function setRoom(connId: string, key: string, asset: string): Party | undefined {
  const party = partyOf(connId);
  const member = party?.members.get(connId);
  if (!party || !member) return undefined;

  if (member.roomKey !== key) {
    member.roomKey = key;
    member.roomSince = ++party.roomSeq;
  }
  member.roomAsset = asset;
  return party;
}

// Who's in which room, and who runs each room's enemies/loot: whichever
// member has been in that room longest (lowest roomSince) - "first in
// stays authority until they leave", so someone walking into an occupied
// room joins the existing simulation instead of resetting it. `assets`
// is that authority's room resource per key, which anyone arriving
// afterwards should match (a coordinate's template is re-rolled on each
// fresh entry, so two players could otherwise load different ones).
export function roomMap(party: Party) {
  const rooms: { id: string; key: string; asset: string }[] = [];
  const auth: Record<string, string> = {};
  const assets: Record<string, string> = {};
  const since: Record<string, number> = {};

  for (const m of party.members.values()) {
    rooms.push({ id: m.connId, key: m.roomKey, asset: m.roomAsset });
    if (m.roomKey === "") continue;
    if (!(m.roomKey in since) || m.roomSince < since[m.roomKey]) {
      since[m.roomKey] = m.roomSince;
      auth[m.roomKey] = m.connId;
      assets[m.roomKey] = m.roomAsset;
    }
  }
  return { t: "room_map", rooms, auth, assets };
}
