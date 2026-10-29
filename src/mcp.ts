// The AI connection: a Model Context Protocol endpoint (streamable HTTP, JSON responses) at
// a private link, /mcp/<token>. Claude (desktop, web or phone, as a custom connector) or any
// MCP client can read, search, write and sort the account's notes with it.
//
// Behind it runs the same client the apps use (@lumen/shared/client) over an in-memory
// database, synced through this server's own endpoints: every edit is an ordinary op from an
// "AI connection" device, permission-checked and relayed live to the person's devices.

import { Database } from "bun:sqlite";
import { createLumen, isGroup, pageTitle, type Lumen, type PageNode, type SqlDriver } from "@lumen/shared/client";
import { pageToMarkdown } from "@lumen/shared/export";
import type { UserRow } from "@lumen/shared/schema/server";

const IDLE_MS = 10 * 60_000;

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

const TOOLS = [
  {
    name: "list_pages",
    description: "Lists every page the person can see, as an indented outline with ids: their workspaces (groups marked [group]) and pages shared with them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_page",
    description: "Reads a page as Markdown, with the titles and ids of the pages inside it.",
    inputSchema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  },
  {
    name: "search",
    description: "Full-text search over every page. Returns matching pages with a snippet.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "create_page",
    description: "Creates a page, optionally inside another page or a group (parent_id), with Markdown content.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, markdown: { type: "string" }, parent_id: { type: "string", description: "A page or group id; omit for the top level." } },
      required: ["title"],
    },
  },
  {
    name: "write_page",
    description: "Adds Markdown to the end of a page (mode \"append\", the default) or replaces its text (mode \"replace\"; pages inside it are kept).",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string" }, markdown: { type: "string" }, mode: { type: "string", enum: ["append", "replace"] } },
      required: ["page_id", "markdown"],
    },
  },
  {
    name: "rename_page",
    description: "Changes a page's or group's title.",
    inputSchema: { type: "object", properties: { page_id: { type: "string" }, title: { type: "string" } }, required: ["page_id", "title"] },
  },
  {
    name: "create_group",
    description: "Creates a group: a sidebar section that holds pages (for sorting). Returns its id.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "move_page",
    description: "Moves a page into another page or a group (to_id), or to the top level (to_id null). Use it to sort and organise.",
    inputSchema: { type: "object", properties: { page_id: { type: "string" }, to_id: { type: ["string", "null"] } }, required: ["page_id", "to_id"] },
  },
  {
    name: "trash_page",
    description: "Moves a page to the trash (it can be restored from the app).",
    inputSchema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  },
] as const;

type Args = Record<string, unknown>;
const str = (args: Args, key: string) => {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`"${key}" is required.`);
  return v;
};

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

  const outline = (nodes: PageNode[], depth = 0): string[] =>
    nodes.flatMap((n) => [`${"  ".repeat(depth)}- ${pageTitle(n.page)}${isGroup(n.page) ? " [group]" : ""} (id: ${n.page.id})`, ...outline(n.children, depth + 1)]);

  async function call(lumen: Lumen, name: string, args: Args): Promise<string> {
    await lumen.sync?.sync().catch(() => {});
    const space = await lumen.getSpace();
    const after = async (text: string) => {
      await lumen.sync?.sync();
      return text;
    };
    switch (name) {
      case "list_pages": {
        const lines: string[] = [];
        for (const s of await lumen.listSpaces()) lines.push(`Workspace "${s.space.name}" (${s.role})`, ...outline(await lumen.pageTree(s.space), 1));
        const shared = await lumen.sharedPages();
        if (shared.length) lines.push("Shared with them", ...shared.map((p) => `  - ${pageTitle(p.page)} (id: ${p.page.id}, ${p.role})`));
        return lines.join("\n") || "No pages yet.";
      }
      case "read_page": {
        const page = await lumen.getBlock(str(args, "page_id"));
        if (!page?.alive) throw new Error("No such page.");
        const children = await lumen.childPages(page.id);
        const md = pageToMarkdown(page, await lumen.loadPageBlocks(page.id));
        const inside = children.length ? `\n\nPages inside:\n${children.map((c) => `- ${pageTitle(c)} (id: ${c.id})`).join("\n")}` : "";
        return md + inside;
      }
      case "search": {
        const hits = await lumen.search(str(args, "query"));
        if (!hits.length) return "Nothing found.";
        const lines = await Promise.all(hits.map(async (h) => `- ${pageTitle((await lumen.getBlock(h.pageId))!)} (id: ${h.pageId}): ${h.snippet.slice(0, 200)}`));
        return lines.join("\n");
      }
      case "create_page": {
        if (!space) throw new Error("No workspace to create pages in.");
        const parent = typeof args.parent_id === "string" && args.parent_id ? args.parent_id : null;
        const target = parent ? await lumen.getBlock(parent) : undefined;
        const id = await lumen.createPage(target ? ({ id: target.space_id } as never) : space, parent);
        await lumen.renamePage(id, str(args, "title"));
        if (typeof args.markdown === "string" && args.markdown.trim()) await lumen.writeMarkdown(id, args.markdown);
        return after(`Created "${args.title}" (id: ${id}).`);
      }
      case "write_page": {
        const mode = args.mode === "replace" ? "replace" : "append";
        await lumen.writeMarkdown(str(args, "page_id"), str(args, "markdown"), mode);
        return after(mode === "replace" ? "Replaced the page's text." : "Added to the page.");
      }
      case "rename_page":
        await lumen.renamePage(str(args, "page_id"), str(args, "title"));
        return after("Renamed.");
      case "create_group": {
        if (!space) throw new Error("No workspace to create groups in.");
        const id = await lumen.createGroup(space, str(args, "name"));
        return after(`Created group "${args.name}" (id: ${id}).`);
      }
      case "move_page": {
        const to = typeof args.to_id === "string" && args.to_id ? args.to_id : null;
        await lumen.movePage(str(args, "page_id"), to);
        return after("Moved.");
      }
      case "trash_page":
        await lumen.setPageAlive(str(args, "page_id"), false);
        return after("Moved to the trash.");
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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
