# SMS Quest server

Persistence backend: auth (register/login), character save/load,
dungeon-run logging, teacher accounts/classes/question sets, and the
multiplayer relay (`ws.ts`/`party.ts`). Postgres via `pg` - was SQLite
(`node:sqlite`) through Milestone 71; swapped for Milestone 72's Render
deploy, since Render's web services have ephemeral disk (a SQLite file
there is wiped on every redeploy and every free-tier spin-down). Every
query is written with `?` placeholders and rewritten to Postgres's `$1,
$2...` by `db.ts`'s `dbGet`/`dbAll`/`dbRun`/`dbInsertId` helpers, so the
route files still read close to how they did under SQLite.

## Run it

Needs a Postgres to point at - Render's (see "Deploying to Render" below),
or any local Postgres for dev (a local install, or `docker run -e
POSTGRES_PASSWORD=postgres -p 5432:5432 postgres` if you have Docker).

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL
npm run dev
```

Listens on `http://localhost:4000` (override with a `PORT` env var). Tables
are created automatically on first boot (`initDb()` in `db.ts`) - nothing
to migrate by hand.

Teacher dashboard: `http://localhost:4000/teacher.html` (create a class
and question sets there, get a join code for students).

## Deploying to Render

`render.yaml` at the repo root is a Render Blueprint - it defines both this
web service and a Postgres instance, wired together (`DATABASE_URL` is set
automatically from the database's connection string). See the top-level
`DEVELOPMENT.md`'s Milestone 72 section for the full click-by-click deploy
walkthrough. Short version: push this repo to GitHub, then in Render
**New > Blueprint**, pick the repo, and it provisions both services from
`render.yaml`.

After deploying, two client-side config values need to point at the new
server instead of localhost - see `DEVELOPMENT.md` Milestone 72.

## API

All bodies and responses are JSON. Authenticated routes take
`Authorization: Bearer <token>` from register/login's response. There are
two account types (`users.role`) that can't cross into each other's
endpoints — a student token 403s on `/api/teacher/*`, a teacher token
401s on `/api/login`.

### Student (existing accounts, from the game client)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/api/register` | - | `{username, password}` | username 3+ chars, password 4+. 409 if taken. |
| POST | `/api/login` | - | `{username, password}` | 401 on bad credentials or a teacher account. |
| GET | `/api/character` | yes | - | Current character snapshot. |
| PUT | `/api/character` | yes | full character snapshot | Last-write-wins full replace, not a diff. |
| POST | `/api/change-password` | yes | `{current_password, new_password}` | Works for either account role. 401 if `current_password` is wrong; new one needs 4+ chars. |
| POST | `/api/dungeon-runs` | yes | `{dungeon_name, xp_gained}` | Insert-only log, nothing reads it back yet. |
| POST | `/api/classes/join` | yes | `{join_code}` | Replaces any existing class membership - one class at a time. 404 on a bad code. |
| POST | `/api/classes/leave` | yes | - | Clears the student's `class_members` row. `{ok: true}` whether or not they were in one. |
| GET | `/api/my-questions` | yes | - | Every question from every question set assigned to the student's class, flattened into one array. `{questions: []}` if not in a class or nothing's assigned. |
| POST | `/api/question-attempts` | yes | `{question_id, topic, correct}` | Fire-and-forget from the client's event bus. `class_id` is recorded server-side from current membership, not trusted from the client. |
| GET | `/api/my-accuracy` | yes | - | Own `{attempts, correct, by_topic: [{topic, attempts, correct_count}]}`. |
| GET | `/api/my-class-progress` | yes | - | `{has_class: false}`, or `{has_class: true, class_name, total_correct, tier_index, tier_name, next_threshold}` — the whole class's cumulative correct answers mapped against a 5-tier "Class Castle" progression (see `CASTLE_TIERS` in `routes/student.ts`). |

Character snapshot shape (see `src/types.ts`):
`{level, xp, xp_to_level, base_max_hp, base_atk_damage, inventory: Item[], equipped_weapon, equipped_helmet, equipped_chest, equipped_accessory}`,
where an `Item` is whatever `scr_generate_item()` produces on the GameMaker
side (`objects` are plain JSON, not GameMaker instances) - keep `types.ts`
and `scr_items.gml` in sync by hand, there's no shared schema file yet.

### Teacher (`/api/teacher/*`, from `teacher.html`)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/teacher/register` | `{username, password}`, no auth. |
| POST | `/api/teacher/login` | `{username, password}`, no auth. |
| POST | `/api/teacher/classes` | `{name}` → generates a 6-char join code (no `0/O/1/I/L`). |
| GET | `/api/teacher/classes` | List own classes with student counts. |
| GET | `/api/teacher/classes/:id` | Class detail: roster + assigned sets. |
| POST | `/api/teacher/classes/:id/assign` | `{question_set_id}`. |
| DELETE | `/api/teacher/classes/:id/assign/:setId` | Unassign. |
| POST | `/api/teacher/question-sets` | `{title, subject, grade}`. |
| GET | `/api/teacher/question-sets` | List own sets with question counts. |
| GET | `/api/teacher/question-sets/:id` | Set detail + its questions. |
| PUT | `/api/teacher/question-sets/:id` | `{title, subject, grade}`. |
| DELETE | `/api/teacher/question-sets/:id` | Cascades to its questions + assignments. |
| POST | `/api/teacher/question-sets/:id/questions` | `{question_type, prompt, answers[], correct_index, explanation, difficulty, topic, tags[]}`. |
| PUT | `/api/teacher/questions/:id` | Same body shape. |
| DELETE | `/api/teacher/questions/:id` | |
| GET | `/api/teacher/classes/:id/analytics` | `{class, students: [{username, attempts, correct_count}], questions: [{id, prompt, topic, attempts, correct_count}]}` — students with zero attempts still appear (0/0), not omitted. |
| GET | `/api/teacher/classes/:id/students/:studentId` | Per-student drill-down: `{student, overall, question_sets: [{id, title, attempts, correct_count, questions: [...]}]}`, scoped to sets assigned to the class. |
| POST | `/api/teacher/classes/:id/students/:studentId/reset-password` | `{new_password}` (4+ chars) → `{ok: true}`. No old-password check - this IS the recovery path for a student who forgot theirs. Scoped to students in one of the teacher's own classes. |
| POST | `/api/teacher/question-sets/:id/import-csv` | `{csv: "<raw file text>"}` → `{imported: N}`, or 400 with `{error, row_errors: [{row, error}]}` if any row is invalid — all-or-nothing, nothing partial ever lands. Template: `GET /question-set-template.csv` (static file). |

A question's shape matches `scr_questions.gml`'s struct fields exactly, so
`/api/my-questions` hands them to the GameMaker client with no
translation needed on either side. The CSV importer (`src/csv.ts` +
`routes/teacher.ts`) produces rows in this same shape - there's one
Question format in the system, not a CSV-specific variant.

### Multiplayer relay (`server/src/ws.ts`, `server/src/party.ts`)

A plain WebSocket on the same HTTP server/port as the REST API above (no
separate path - GameMaker's WS client takes a bare host+port, not a URL
with a path, see `network_connect_raw_async`). One JSON object per frame,
no length-prefix framing needed (GameMaker delivers WebSocket messages
whole). A connection must send `{"t":"auth","token":"<bearer token>"}`
as its first message - everything else is rejected until that succeeds,
since a WS upgrade request can't carry an `Authorization` header the way
an HTTP request can.

Client -> server messages: `{t:"auth",token}`, `{t:"create"}` (new
party, sender becomes host), `{t:"join",code}`, `{t:"leave"}`,
`{t:"pos",x,y,facing}`, `{t:"ping",kind}` (`kind` one of `follow` /
`help` / `ready` / `look`), `{t:"room",key,asset}` (Milestone 34 - see
below).

Server -> client messages: `{t:"auth_ok",id}` / `{t:"auth_err",error}`,
`{t:"party_ok",code,host,members:[{id,username,x,y,facing}]}` /
`{t:"party_err",error}`, `{t:"member_join",id,username}`,
`{t:"member_leave",id}`, `{t:"member_pos",id,x,y,facing}`,
`{t:"member_ping",id,kind}`, `{t:"host_changed",id}` (host disconnected -
whoever's been in the party longest is promoted), `{t:"error",error}`,
`{t:"room_map",rooms:[{id,key,asset}],auth:{<key>:<connId>},assets:{<key>:<asset>}}`
(Milestone 34 - see below).

**Room tracking (Milestone 34, split-party overworld)** - the one place the
server stopped being a pure relay. Party members can now be in different
rooms at once (overworld and hub; dungeons still keep everyone together), so
each room needs exactly one client to run its enemies and drops, and every
client has to agree which. A client announces `{t:"room",key,asset}` each
time it loads a room - `key` is an opaque string the *client* defines (the
server never interprets it; the game uses `"hub"`, `"w:x,y"` for an overworld
coordinate, `"d:x,y"` for a dungeon room, since one GameMaker room resource
represents many coordinates) and `asset` is the room resource it loaded. The
server stamps each member with a party-wide arrival counter when their `key`
changes (re-announcing the same key with a different `asset` doesn't count as
arriving again) and broadcasts `room_map` to the *whole* party, sender
included: every member's `{id,key,asset}`, plus per key the **authority** -
whoever has been in that key longest ("first in stays authority until they
leave", so walking into an occupied room joins its simulation instead of
resetting it) - and that authority's `asset`, which later arrivals should
match (a coordinate's template is re-rolled on each fresh entry, so two
players could otherwise load different ones). Rebroadcast when anyone leaves
or disconnects, so a departing authority is replaced.

**Generic passthrough (Milestone 14)**: any message type not listed above
falls through to a plain relay - the server stamps `from:<sender's id>`
and either sends it to one specific party member (if the message has a
`to` field naming their id) or broadcasts it to the rest of the sender's
party (if not), same as `pos`/`ping` above. It's never parsed or
interpreted beyond that. This is how shared dungeon combat's messages
work with zero server-side code specific to them:
`{t:"enter_room",room,x,y}` (host moves the whole party to a new room -
broadcast), `{t:"enemy_sync",enemies:[{id,enemy_type,x,y,hp,max_hp,is_dead,hurt_flash,slam_telegraph,telegraph_timer,pattern_state}]}`
(host's periodic enemy snapshot, now including the dynamic fields each
enemy type's Draw event needs for hit-flash and AoE telegraph rings, not
just body/position - broadcast), `{t:"attack_enemy",enemy_id,damage}`
(a guest's hit request - broadcast, only the host acts on it),
`{t:"damage_guest",to,amount}` (host's authoritative damage to one guest -
targeted), `{t:"enemy_died",enemy_type,xp_reward,dropped,item,drop_id,x,y,is_boss}`
(the host's already-resolved kill reward, `item` being the exact struct
it generated for its own drop, not a rarity floor a guest would have to
re-roll, and `drop_id` tying every party member's copy of that drop
together so any one of them picking it up can make the rest disappear
too - broadcast), `{t:"projectile_spawn",x,y,direction,speed,id}`
(Milestone 16 - relayed once at creation, not on a timer, since
GameMaker's built-in speed/direction auto-integration flies a guest's
cosmetic copy identically with no further sync - broadcast),
`{t:"projectile_destroy",id}` (Milestone 18 - sent the moment the host's
real shot actually resolves a hit, so every party member's copy of that
same `id` disappears at the same moment, not just whichever one client's
screen it happened to touch - broadcast), `{t:"item_claimed",drop_id}`
(Milestone 16 - broadcast the moment anyone picks up a shared drop, so
every other party member's copy of that same `drop_id` removes itself),
`{t:"xp_award",to,amount}` (Milestone 17 - one contributor's proportional
share of a kill, computed host-side from tracked damage - targeted, only
sent to party members who actually dealt some), `{t:"player_status",level,hp,max_hp}`
(Milestone 23 - drives the party status HUD, sent on the same timer as
`pos` - broadcast, relies on the server's own `from` stamp rather than a
dedicated `id` field the way `pos`/`member_pos` has one),
`{t:"item_drop",item,drop_id,x,y}` (Milestone 25 - a standalone shared
drop with no kill-reward side effects attached, unlike `enemy_died` -
used for a bonus potion an enemy might drop alongside its normal loot,
but generic enough for any future "this appeared, no reward attached"
case too - broadcast). Any future message type - a new ping kind, a new
sync feed - needs no server change at all as long as it fits this
broadcast-or-targeted shape.

**Room-scoped messages (Milestone 34)**: the relay still broadcasts these
to the whole party - narrowing the audience is the *client's* job. Anything
that only makes sense to people standing in the same room (`enemy_sync`,
`attack_enemy`, `enemy_died`, `projectile_spawn`/`projectile_destroy`,
`item_drop`, `item_claimed`, and the two below) carries an `rk` field - the
sender's room key - and a receiver whose own key differs drops it. Without
it a player in another room would spawn puppets of enemies that aren't
there. Two more messages in that shape: `{t:"party_action",to,rk,kind,dir,tx,ty}`
(a member asking their room's authority to carry out a party-wide action -
`kind` is `enter_dungeon` / `door` / `leave_dungeon`; targeted at the
authority so exactly one client acts, no matter how many people touched the
door) and `{t:"room_state",to,rk,drops:[{id,item,x,y}],claimed:[id]}` (the
authority catching a newly-arrived member up on loot already on the ground
and shared pickups already claimed this visit - targeted). Unscoped
party-wide messages: `enter_room` / `enter_dungeon_room` (an actual
whole-party move), `dungeon_layout`, `dungeon_room_cleared`, `player_status`
(now also carries `dead`).

Parties are in-memory only, on purpose - a live-session concept with no
DB table, since nobody needs to rejoin a party after a server restart.
Max 4 members; a 4-character join code (same no-`0/O/1/I/L` alphabet as
class join codes, see `generateJoinCode` in `routes/teacher.ts`).

## Verified

**Student/character (Milestone 5)**: registered/logged in, saved a
character with equipped gear, reloaded it and got the exact struct back,
logged a dungeon run, confirmed wrong password / missing token both 401
and duplicate username 409s — all via curl.

**Teacher/classes/questions (Milestone 6)**: full lifecycle via curl
(register teacher, create class, create question set, add/edit/delete
questions, assign/unassign to class) plus the actual dashboard UI in a
real browser (create class, open it, add a question through the form,
confirm it lands correctly). Then end-to-end through the game client: a
student registered, joined a class by its real join code, and
`GET /api/my-questions` — and the client's `global.assigned_questions` —
came back with exactly the questions assigned to that class. Also caught
and fixed a real routing bug in the process (see the top-level
`DEVELOPMENT.md`, Milestone 6 section).

**Analytics (Milestone 7)**: fired a real `QUESTION_CORRECT` event through
the game client's actual event-bus listener chain (not a direct API call),
confirmed the resulting row landed in `question_attempts` via
`/api/my-accuracy`, then confirmed it rendered correctly - correct counts,
accuracy percentages, color coding - in `teacher.html`'s Analytics view in
an actual browser.

**CSV import (Milestone 10)**: curl covered the backend (a real import of
the downloadable template, then every validation failure - missing
column, bad `question_type`, out-of-range `correct_index`, and a mixed
good+bad-row file confirming the import is atomic, not partial). The
browser-side button handler was verified separately by simulating a file
selection (`DataTransfer` + a real click on the Import button, since
nothing can drive a native OS file picker) - both the success message and
the multi-line error display were confirmed rendering correctly against
the live DOM, not just the API response.

**Class Town (Milestone 11)**: verified the tier math itself, not just
that the endpoint responds - confirmed tier 0 at the real class's actual
attempt count, then pushed the count past the first threshold with a
direct DB write and confirmed a re-fetch actually advanced to tier 1 with
the correct next threshold. Then ran the real game client through login
and confirmed `obj_class_castle`'s fetched values matched the server
exactly. Synthetic test attempts were removed afterward so the real
class's numbers weren't left inflated.

**Multiplayer relay (Milestone 13)**: two real WebSocket clients (a
Node script, not the game) driven through the full protocol against the
live server - host creates a party, guest joins by its real code and
gets the correct roster back, position and ping messages relay to the
other member only, leave and disconnect both clean up party state
correctly including host handoff. The GameMaker client side was verified
by a full real build compiling clean and reaching its main loop, but an
actual two-window playtest (two logged-in clients in the same party in
the hub) is still open - see the top-level `DEVELOPMENT.md`, Milestone
13 section, for why and what that entails.

**Shared dungeon combat relay (Milestone 14)**: two real WebSocket
clients exercising the generic passthrough directly - a broadcast
message (`enemy_sync`) reached the other party member with `from`
stamped correctly, a targeted message (`damage_guest` with a `to` field)
reached only the addressed member, and a reverse-direction broadcast
(`attack_enemy`, guest to host) reached the host correctly. The GameMaker
side compiled clean and reached its main loop with no runtime errors
across every touched enemy/projectile/exit-trigger object; an actual
two-window co-op dungeon run is still open for the same reason Milestone
13's was - see `DEVELOPMENT.md`, Milestone 14 section.

**Fair co-op rewards + host migration (Milestone 15)**: needed zero
server-side changes - `enemy_died` is a plain broadcast through the same
passthrough already proven above, and `host_changed` already existed
from Milestone 13. Verification was entirely GML-side (clean build, main
loop reached, every touched death block re-read to confirm the new
broadcast call is a no-op outside a party) - see `DEVELOPMENT.md`,
Milestone 15 section.

**Real-object mirroring (Milestone 16)**: also needed zero server-side
changes - `projectile_spawn` and `item_claimed` are both plain broadcasts
through the same passthrough. Verification was entirely GML-side (clean
build, main loop reached) across every enemy type, `obj_projectile`,
`obj_item_pickup`, and the deletion of the now-unused `obj_enemy_ghost`
object - see `DEVELOPMENT.md`, Milestone 16 section.

**Contribution damage fixes + proportional XP (Milestone 17)**: also
needed zero server-side changes - `xp_award` is a plain targeted message
through the same passthrough. Two real bugs from Milestone 16 fixed here
too (guests couldn't damage anything - a wrong id in `attack_enemy`;
projectiles passed through players instead of vanishing on contact) plus
the proportional-XP design change, all from the same user playtest.
Verification was GML-side (clean build, main loop reached) plus hand-
tracing `mp_award_split_xp`'s split math and solo-play fallback - see
`DEVELOPMENT.md`, Milestone 17 section.

**Projectile sync, death handling, host-only exits (Milestone 18)**:
also needed zero server-side changes - `projectile_destroy` is a plain
broadcast through the same passthrough, and the death/exit fixes are
entirely client-side (`enter_room`'s existing payload already carried
everything the revive-on-arrival logic needed). Verification was
GML-side (clean build, main loop reached) across every exit trigger,
`obj_player`, and `obj_projectile` - see `DEVELOPMENT.md`, Milestone 18
section.

**Host death no longer strands the party (Milestone 19)**: no server or
protocol changes at all - a one-line client fix (the host's respawn now
calls `mp_room_goto` instead of a bare `room_goto`, reusing the
`enter_room` broadcast every exit trigger already sends). Verification
was GML-side (clean build, main loop reached) - see `DEVELOPMENT.md`,
Milestone 19 section.

**Shared, stackable quest items (Milestone 22)**: no server or protocol
changes at all - reuses Milestone 16's existing `item_claimed` message
verbatim for a statically-placed quest item, keyed by its own `x_y`
position instead of a dynamically-assigned id, since every client
already loads an identical instance at an identical spot. Verification
was GML-side (clean build, main loop reached) - see `DEVELOPMENT.md`,
Milestone 22 section.

**Party HUD + real player visuals (Milestone 23)**: no server changes
for the visual half (Draw-event-only), but the new `player_status`
message was verified against the live server with two real WebSocket
clients - confirmed `from` arrives correctly on a message with no
dedicated server case of its own, and the guest-side handler reads it
into the right party member. See `DEVELOPMENT.md`, Milestone 23 section.

**Health potions (Milestone 25)**: no server changes for the
item/UI half, but the new `item_drop` message was verified against the
live server with two real WebSocket clients - confirmed the full item
struct (including `heal_pct`) round-trips intact with `from` correctly
stamped. See `DEVELOPMENT.md`, Milestone 25 section.

**Standing class membership (Milestone 12)**: a real 3-stage round trip
through the actual game client - logged in with no class code and
confirmed a previously-joined class's questions loaded automatically,
called `/api/classes/leave` via the new hub desk and confirmed the pool
fell back to local practice questions, rejoined and confirmed both the
question pool and the desk's displayed class name came back correct.
Also caught a real GML closure bug in the process (client crashed
mid-playtest) - see the top-level `DEVELOPMENT.md`, Milestone 12 section.

**Split-party room tracking (Milestone 34)**: the authority rules
(`setRoom`/`roomMap` in `party.ts`) were unit-tested directly - first-in
stays authority, a latecomer's differing room resource doesn't displace
the canonical one, correcting to it doesn't jump the arrival queue, a
returning member doesn't reclaim authority, and authority passes on when
the authority walks to another room or leaves the party. The wire
behavior was then verified against the live server with two real
WebSocket clients: `room_map` reaches the whole party *including* the
sender, the `rk` room tag survives the generic relay untouched, a
`party_action` addressed to the authority reaches only them (not echoed to
the sender), authority moves to the remaining member when the authority
changes rooms, and the map is rebroadcast without the leaver on `leave`.
Throwaway accounts used for the test were deleted afterward. See
`DEVELOPMENT.md`, Milestone 34 section. The GML client half is only
build-verified.

**Trial rooms / boss ward (Milestone 36)**: no server changes - two more
generic-passthrough messages, both party-wide (deliberately *not* room-
scoped, since they update shared dungeon state that every client's copy of
the layout needs): `{t:"quiz_answered",dx,dy}` (this player - identified by
the server's `from` stamp - answered the trial room at dungeon coordinate
`dx,dy`; recorded on every client's layout so a room's doors open once every
living member has answered) and `{t:"boss_ward"}` (a correct trial answer
weakening this run's boss; every client applies it, since only the boss
room's authority runs the boss but it needs every player's contribution).
Not exercised against the live server - both are the same broadcast shape as
`dungeon_room_cleared`, which already is.
