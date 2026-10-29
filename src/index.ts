import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backfillRegistry, createApp } from "./app";
import { openDb } from "./db";
import { createHub, type LiveSocket } from "./live";

// Optional: the shared token from before accounts. Signed-in devices that know it can claim
// the workspaces stored back then (POST /auth/claim-legacy).
const legacyToken = process.env.LUMEN_TOKEN || undefined;

const dbPath = process.env.LUMEN_DB ?? "./data/lumen-server.db";
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
backfillRegistry(db);
const hub = createHub();
const { app, auth } = createApp(db, { hub, legacyToken });
const port = Number(process.env.PORT ?? 8787);

Bun.serve<LiveSocket["data"]>({
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/sync/live") {
      // Browsers can't set headers on a WebSocket, so the token comes in the query.
      const user = auth.authenticate(url.searchParams.get("token") ?? "");
      if (!user) return new Response("unauthorized", { status: 401 });
      const deviceId = url.searchParams.get("device_id") ?? "";
      return server.upgrade(req, { data: { userId: user.id, deviceId } }) ? undefined : new Response("expected a WebSocket", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open: (ws) => hub.add(ws),
    close: (ws) => hub.remove(ws),
    message() {},
  },
});
console.log(`Lumen sync server on :${port} (db: ${dbPath})`);
