// Sync relay. Stores ops from devices and serves them back in arrival order (seq).
// It never merges records itself; every client merges with applyOp from @lumen/shared.

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { asc, gt } from "drizzle-orm";
import { pullQuerySchema, pushRequestSchema, type PullResponse, type PushResponse } from "@lumen/shared";
import { server_ops } from "@lumen/shared/schema/server";
import type { Db } from "./db";

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createApp(db: Db, token: string) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/sync/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ") || !sameToken(header.slice(7), token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.post("/sync/push", async (c) => {
    const parsed = pushRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const { ops } = parsed.data;
    let accepted = 0;
    if (ops.length) {
      const now = Date.now();
      const inserted = db
        .insert(server_ops)
        .values(ops.map(({ table, ...op }) => ({ ...op, table_name: table, received_at: now })))
        .onConflictDoNothing({ target: server_ops.id })
        .returning({ seq: server_ops.seq })
        .all();
      accepted = inserted.length;
    }
    return c.json({ accepted } satisfies PushResponse);
  });

  app.get("/sync/pull", (c) => {
    const parsed = pullQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
    const { since, limit, device_id } = parsed.data;
    const rows = db.select().from(server_ops).where(gt(server_ops.seq, since)).orderBy(asc(server_ops.seq)).limit(limit).all();
    // The cursor moves past every scanned row, including this device's own ops, which are not sent back.
    const cursor = rows.at(-1)?.seq ?? since;
    const ops = rows
      .filter((r) => r.device_id !== device_id)
      .map(({ table_name, record_id, id, path, value, hlc, device_id }) => ({
        id,
        table: table_name,
        record_id,
        path,
        value: value ?? null,
        hlc,
        device_id,
      }));
    return c.json({ ops, cursor, has_more: rows.length === limit } satisfies PullResponse);
  });

  return app;
}
