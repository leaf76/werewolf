/**
 * Edge entry point: room allocation, WebSocket routing to the room DO, and
 * serving the static frontend. All game rules live in the RoomDO.
 */

export { RoomDO } from "./room";

/** Unambiguous alphabet: no 0/O, 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function withSecurityHeaders(response: Response): Response {
  if (response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Native clients (Godot, bots, tests) omit Origin; browsers must match this host. */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const url = new URL(request.url);
  if (origin === url.origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function roomIndexed(env: Env, code: string): Promise<boolean> {
  return (await env.ROOM_INDEX.get(code)) === "1";
}

async function allowCreate(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  try {
    const { success } = await env.CREATE_LIMIT.limit({ key: ip });
    return success;
  } catch {
    // Miniflare/tests often lack a working Rate Limit binding (`cf` is absent).
    // On the edge, fail closed so a broken limiter cannot silently uncap creates.
    return request.cf === undefined;
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/rooms" && request.method === "POST") {
    if (!(await allowCreate(env, request))) {
      return json({ error: "rate limited" }, 429);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomRoomCode();
      const claimed = await env.ROOM.getByName(code).claim(code);
      if (claimed) {
        return json({ code, url: `${url.origin}/r/${code}` }, 201);
      }
    }
    return json({ error: "could not allocate a room code" }, 503);
  }

  const info = path.match(ROOM_INFO_RE);
  if (info && request.method === "GET") {
    const code = info[1]!.toUpperCase();
    const exists = await roomIndexed(env, code);
    return json({ exists }, 200);
  }

  const ws = path.match(WS_PATH_RE);
  if (ws) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    if (!originAllowed(request)) {
      return new Response("origin not allowed", { status: 403 });
    }
    const code = ws[1]!.toUpperCase();
    if (!(await roomIndexed(env, code))) {
      return new Response("room not found", { status: 404 });
    }
    return env.ROOM.getByName(code).fetch(request);
  }

  if (ROOM_PAGE_RE.test(path)) {
    return env.ASSETS.fetch(new URL("/room.html", url));
  }

  if (path.startsWith("/api/")) {
    return json({ error: "not found" }, 404);
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    return withSecurityHeaders(await handle(request, env));
  },
} satisfies ExportedHandler<Env>;
