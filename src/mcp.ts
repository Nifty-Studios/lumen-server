// The AI connection: a Model Context Protocol endpoint (streamable HTTP, JSON responses) at
// a private link, /mcp/<token>. Claude (desktop, web or phone, as a custom connector) or any
// MCP client can read, search, write and sort the account's notes with it.
//
// Behind it runs the same client the apps use (@lumen/shared/client) over an in-memory
// database, synced through this server's own endpoints: every edit is an ordinary op from an
// "AI connection" device, permission-checked and relayed live to the person's devices.

import { Database } from "bun:sqlite";
import { NOTE_TOOLS, createLumen, runNoteTool, type Lumen, type SqlDriver } from "@lumen/shared/client";
import type { UserRow } from "@lumen/shared/schema/server";

/** An AI link's client is dropped after this long unused, freeing its copy of the notes. */
const IDLE_MS = 3 * 60_000;

function memoryDriver(): SqlDriver {
  const conn = new Database(":memory:");
  const run = (sql: string, params: unknown[], method: string): unknown[] => {
    const stmt = conn.query(sql);
    if (method === "run") {
      stmt.run(...(params as never[]));
      return [];
    }
    const rows = stmt.values(...(params as never[])) as unknown[][];
    return method === "get" ? (rows[0] ?? []) : rows;
  };
  return {
    query: async (sql, params, method) => run(sql, params, method),
    batch: async (queries) => conn.transaction(() => queries.map((q) => run(q.sql, q.params, q.method)))(),
  };
}

const TOOLS = NOTE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

type Args = Record<string, unknown>;

export function createAgents(fetchImpl: typeof fetch) {
  const clients = new Map<string, { lumen: Promise<Lumen>; last: number }>();

  // Idle clients are dropped; their next call starts over with a fresh pull.
  setInterval(() => {
    for (const [token, c] of clients) if (Date.now() - c.last > IDLE_MS) clients.delete(token);
  }, 60_000).unref?.();

  function clientFor(token: string, user: UserRow) {
    let entry = clients.get(token);
    if (!entry) {
      const lumen = (async () => {
        const l = createLumen(memoryDriver(), { server: { url: "http://lumen.internal", deviceName: "AI connection", fetch: fetchImpl } });
        await l.start();
        await l.account.adopt({ user: { id: user.id, email: user.email, name: user.name }, token });
        await l.connect();
        return l;
      })();
      lumen.catch(() => clients.delete(token));
      entry = { lumen, last: 0 };
      clients.set(token, entry);
    }
    entry.last = Date.now();
    return entry.lumen;
  }

  async function call(lumen: Lumen, name: string, args: Args): Promise<string> {
    await lumen.sync?.sync().catch(() => {});
    const text = await runNoteTool(lumen, name, args);
    // A write isn't done until the server has it (a permission error surfaces here).
    if (NOTE_TOOLS.find((t) => t.name === name)?.writes) await lumen.sync?.sync();
    return text;
  }

  /** One JSON-RPC message in, one response out (undefined for notifications). */
  async function handle(token: string, user: UserRow, msg: { id?: unknown; method?: string; params?: Args }) {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.id === undefined) return undefined; // notifications need no answer
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "lumen", version: "1.0.0" },
          instructions:
            `These are ${user.name}'s notes in Lumen. Use list_pages or search to find things, read_page to read them, ` +
            "and the write tools to change them. Changes appear on their devices within seconds. Ask before replacing or trashing anything.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        try {
          const text = await call(await clientFor(token, user), name, (msg.params?.arguments as Args) ?? {});
          return reply({ content: [{ type: "text", text }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  return { handle, forget: (token: string) => clients.delete(token) };
}
