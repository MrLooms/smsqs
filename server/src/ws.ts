import { WebSocketServer, WebSocket } from "ws";
import { Server as HttpServer } from "http";
import crypto from "crypto";
import { resolveToken } from "./auth";
import { createParty, joinParty, leaveParty, partyOf, updatePosition, setRoom, roomMap, Party, PartyMember } from "./party";

// Milestone 13 (Multiplayer, hub-first slice): a thin relay, not a game
// server. The Node side never simulates anything - it just tracks who's
// in which party and forwards position/ping messages between that
// party's own connections. Auth reuses the same bearer tokens as the
// REST API (see resolveToken in auth.ts) since GameMaker's WebSocket
// client can't set the Authorization header on the upgrade request, so
// the token instead travels as this connection's first message.

const PING_KINDS = new Set(["follow", "help", "ready", "look"]);

interface ConnState {
  connId: string;
  userId?: number;
  username?: string;
}

function rosterOf(party: Party) {
  return Array.from(party.members.values()).map((m) => ({
    id: m.connId,
    username: m.username,
    x: m.x,
    y: m.y,
    facing: m.facing,
  }));
}

export function attachMultiplayer(server: HttpServer) {
  // No `path` filter: GameMaker's network_connect_raw_async takes a bare
  // host + port, and this HTTP server has nothing else that upgrades a
  // connection, so there's no ambiguity in accepting every upgrade here.
  const wss = new WebSocketServer({ server });
  const sockets = new Map<string, WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    const state: ConnState = { connId: crypto.randomBytes(8).toString("hex") };
    sockets.set(state.connId, ws);

    const send = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const broadcastToParty = (party: Party, msg: unknown, excludeConnId?: string) => {
      for (const memberId of party.members.keys()) {
        if (memberId === excludeConnId) continue;
        sockets.get(memberId)?.send(JSON.stringify(msg));
      }
    };

    ws.on("message", (raw) => {
      // resolveToken now hits Postgres (async) - the rest of this handler
      // stays sync, so only the auth branch needs to be awaited; wrapped in
      // try/catch so a dropped DB connection closes this one connection
      // instead of crashing the whole relay (an uncaught rejection here
      // would otherwise be unhandled - there's no Express error middleware
      // on a raw WebSocket).
      handleMessage(raw).catch((err) => {
        console.error("WS message handler error:", err);
        send({ t: "error", error: "Internal server error" });
      });
    });

    async function handleMessage(raw: unknown) {
      let msg: any;
      try {
        msg = JSON.parse((raw as Buffer).toString());
      } catch {
        return send({ t: "error", error: "Malformed message" });
      }

      if (msg.t === "auth") {
        const session = typeof msg.token === "string" ? await resolveToken(msg.token) : undefined;
        if (!session || session.role !== "student") {
          send({ t: "auth_err", error: "Invalid token" });
          return ws.close();
        }
        state.userId = session.userId;
        state.username = session.username;
        return send({ t: "auth_ok", id: state.connId });
      }

      // Everything below requires a completed auth handshake first.
      if (state.userId === undefined || state.username === undefined) {
        return send({ t: "error", error: "Not authenticated yet" });
      }

      if (msg.t === "create") {
        const party = createParty(state.connId, state.userId, state.username);
        return send({ t: "party_ok", code: party.code, host: true, members: rosterOf(party) });
      }

      if (msg.t === "join") {
        if (typeof msg.code !== "string") return send({ t: "party_err", error: "Missing party code" });
        const result = joinParty(state.connId, state.userId, state.username, msg.code);
        if ("error" in result) return send({ t: "party_err", error: result.error });

        send({ t: "party_ok", code: result.party.code, host: result.party.hostConnId === state.connId, members: rosterOf(result.party) });
        broadcastToParty(result.party, { t: "member_join", id: state.connId, username: state.username }, state.connId);
        return;
      }

      if (msg.t === "leave") {
        const party = partyOf(state.connId);
        if (!party) return;
        const wasHost = party.hostConnId;
        const remaining = leaveParty(state.connId);
        broadcastToParty(party, { t: "member_leave", id: state.connId }, state.connId);
        if (remaining && remaining.hostConnId !== wasHost) {
          broadcastToParty(remaining, { t: "host_changed", id: remaining.hostConnId });
        }
        // Whoever was running the leaver's room needs replacing.
        if (remaining) broadcastToParty(remaining, roomMap(remaining));
        return;
      }

      // Milestone 34 (split-party overworld): a member announcing which
      // room they just loaded. The server isn't interpreting the key - it
      // only needs to know who shares one, and who's been in it longest,
      // to name a single authority per room (see roomMap). Everyone gets
      // the full map, sender included, so all clients agree.
      if (msg.t === "room") {
        const key = typeof msg.key === "string" ? msg.key : "";
        const asset = typeof msg.asset === "string" ? msg.asset : "";
        const party = setRoom(state.connId, key, asset);
        if (!party) return;
        broadcastToParty(party, roomMap(party));
        return;
      }

      if (msg.t === "pos") {
        const party = updatePosition(state.connId, Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.facing) || 0);
        if (!party) return;
        broadcastToParty(party, { t: "member_pos", id: state.connId, x: msg.x, y: msg.y, facing: msg.facing, drawing: !!msg.drawing, draw_t: Number(msg.draw_t) || 0 }, state.connId);
        return;
      }

      if (msg.t === "ping") {
        if (!PING_KINDS.has(msg.kind)) return;
        const party = partyOf(state.connId);
        if (!party) return;
        broadcastToParty(party, { t: "member_ping", id: state.connId, kind: msg.kind }, state.connId);
        return;
      }

      // Milestone 14 (shared dungeon combat): everything else is a
      // game-specific message (enter_room, enemy_sync, attack_enemy,
      // damage_guest, ...) the server has no business interpreting -
      // it's still just a relay, so any unrecognized type gets forwarded
      // as-is within the sender's party. A `to` field targets one
      // member (e.g. a damage hit meant for exactly one guest);
      // otherwise it broadcasts to the rest of the party, same as pos/ping.
      const party = partyOf(state.connId);
      if (!party) return;
      const out = { ...msg, from: state.connId };
      if (typeof msg.to === "string") {
        if (party.members.has(msg.to)) sockets.get(msg.to)?.send(JSON.stringify(out));
      } else {
        broadcastToParty(party, out, state.connId);
      }
    }

    ws.on("close", () => {
      sockets.delete(state.connId);
      const party = partyOf(state.connId);
      if (!party) return;
      const wasHost = party.hostConnId;
      const remaining = leaveParty(state.connId);
      if (remaining) {
        broadcastToParty(remaining, { t: "member_leave", id: state.connId });
        if (remaining.hostConnId !== wasHost) {
          broadcastToParty(remaining, { t: "host_changed", id: remaining.hostConnId });
        }
        broadcastToParty(remaining, roomMap(remaining));
      }
    });
  });

  return wss;
}
