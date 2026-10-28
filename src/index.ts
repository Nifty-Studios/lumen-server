import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app";
import { openDb } from "./db";

const token = process.env.LUMEN_TOKEN;
if (!token || token.length < 32) {
  console.error("Set LUMEN_TOKEN to a random secret of at least 32 characters (e.g. `openssl rand -hex 32`).");
  process.exit(1);
}

const dbPath = process.env.LUMEN_DB ?? "./data/lumen-server.db";
mkdirSync(dirname(dbPath), { recursive: true });

const app = createApp(openDb(dbPath), token);
const port = Number(process.env.PORT ?? 8787);

Bun.serve({ port, fetch: app.fetch });
console.log(`Lumen sync server on :${port} (db: ${dbPath})`);
