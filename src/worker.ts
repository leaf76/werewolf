/**
 * Edge entry point: room allocation, WebSocket routing to the room DO, and
 * serving the static frontend. All game rules live in the RoomDO.
 */

export { RoomDO } from "./room";

/** Unambiguous alphabet: no 0/O, 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

function randomRoomCode(): string {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

const WS_PATH_RE = /^\/api\/rooms\/([A-Za-z0-9]{6})\/ws$/;
const ROOM_INFO_RE = /^\/api\/rooms\/([A-Za-z0-9]{6})$/;
const ROOM_PAGE_RE = /^\/r\/([A-Za-z0-9]{6})$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/rooms -> allocate a fresh room code.
    if (path === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomRoomCode();
        const claimed = await env.ROOM.getByName(code).claim(code);
        if (claimed) {
          return Response.json({ code, url: `${url.origin}/r/${code}` }, { status: 201 });
        }
      }
      return Response.json({ error: "could not allocate a room code" }, { status: 503 });
    }

    // GET /api/rooms/:code -> existence probe (lets the client fail fast).
    const info = path.match(ROOM_INFO_RE);
    if (info && request.method === "GET") {
      const exists = await env.ROOM.getByName(info[1]!.toUpperCase()).exists();
      return Response.json({ exists });
    }

    // GET /api/rooms/:code/ws -> hand the socket to the room's DO.
    const ws = path.match(WS_PATH_RE);
    if (ws) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      return env.ROOM.getByName(ws[1]!.toUpperCase()).fetch(request);
    }

    // GET /r/:code -> room shell; the client reads the code from the URL.
    if (ROOM_PAGE_RE.test(path)) {
      return env.ASSETS.fetch(new URL("/room.html", url));
    }

    if (path.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // Anything else routed here falls through to static assets.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
