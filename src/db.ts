import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { serverMigrations } from "@lumen/shared/schema/migrations";
import * as schema from "@lumen/shared/schema/server";

export function openDb(path: string) {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");

  sqlite.exec("CREATE TABLE IF NOT EXISTS _migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(sqlite.query<{ tag: string }, []>("SELECT tag FROM _migrations").all().map((r) => r.tag));
  for (const { tag, statements } of serverMigrations) {
    if (applied.has(tag)) continue;
    sqlite.transaction(() => {
      for (const s of statements) sqlite.exec(s);
      sqlite.query("INSERT INTO _migrations (tag, applied_at) VALUES (?, ?)").run(tag, Date.now());
    })();
  }

  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDb>;
