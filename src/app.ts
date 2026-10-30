// Sync relay with accounts. Stores ops from devices and serves them back in arrival order
// (seq), to the people allowed to see them. It never merges records itself; every client
// merges with applyOp from @lumen/shared.

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { and, asc, desc, eq, gt, inArray, isNull, notInArray } from "drizzle-orm";
import {
  canEdit,
  inviteRequestSchema,
  plainText,
  type RichText,
  logInRequestSchema,
  pullQuerySchema,
  pushRequestSchema,
  removePersonSchema,
  signUpRequestSchema,
  type AuthResponse,
  type Me,
  type Op,
  type Person,
  type PullResponse,
  type PushResponse,
} from "@lumen/shared";
import { invites, page_shares, server_ops, server_records, sessions, space_members, type UserRow } from "@lumen/shared/schema/server";
import { checkPush, createRegistry, loadGrants } from "./access";
import { createAuth, createLimiter } from "./auth";
import { createAgents } from "./mcp";
import { addNotification, mountSocial, shareNotification } from "./social";
import type { Db } from "./db";
import type { Hub } from "./live";

type Env = { Variables: { user: UserRow; token: string } };

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name });
const bearer = (c: Context) => {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
};
const clientIp = (c: Context) => c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

export interface AppOptions {
  hub?: Hub;
  /** The single shared token from before accounts; lets its owner claim the old workspaces. */
  legacyToken?: string;
}

export function createApp(db: Db, { hub, legacyToken }: AppOptions = {}) {
  const app = new Hono<Env>();
  const auth = createAuth(db, (userId, n) => addNotification(db, hub, userId, n));
  const limiter = createLimiter();

  // The desktop app calls from a webview origin. Any origin is fine: auth is a bearer token
  // that browsers never attach on their own. Preflights are answered before the auth check.
  app.use(
    "*",
    cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-legacy-token"], allowMethods: ["GET", "POST", "DELETE"], maxAge: 86400 }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // --- accounts ---

  app.post("/auth/signup", async (c) => {
    const parsed = signUpRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Check your name, email and password (at least 8 characters).", issues: parsed.error.issues }, 400);
    const key = `${clientIp(c)}|signup`;
    if (limiter.blocked(key)) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const result = await auth.signUp(parsed.data);
    if (!result) {
      limiter.fail(key);
      return c.json({ error: "An account with this email already exists. Log in instead." }, 409);
    }
    return c.json({ user: publicUser(result.user), token: result.token } satisfies AuthResponse);
  });

  app.post("/auth/login", async (c) => {
    const parsed = logInRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter your email and password." }, 400);
    const key = `${clientIp(c)}|${parsed.data.email}`;
    if (limiter.blocked(key)) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const result = await auth.logIn(parsed.data);
    if (!result) {
      limiter.fail(key);
      return c.json({ error: "That email and password don't match." }, 401);
    }
    limiter.clear(key);
    return c.json({ user: publicUser(result.user), token: result.token } satisfies AuthResponse);
  });

  const signedIn = async (c: Context<Env>, next: () => Promise<void>) => {
    const token = bearer(c);
    const user = auth.authenticate(token);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    c.set("token", token);
    await next();
  };
  for (const path of ["/auth/logout", "/auth/claim-legacy", "/auth/ai-links", "/auth/ai-links/*", "/me", "/sync/*", "/spaces/*", "/pages/*", "/notifications", "/notifications/*", "/friends", "/friends/*", "/dictionary"])
    app.use(path, signedIn);

  mountSocial(app, db, hub);

  // --- AI connection (MCP) ---

  const AI_DEVICE = "AI connection";
  // The agents sync through this app in-process, as any device would.
  const agents = createAgents(((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof fetch);
  const linkFor = (c: Context, token: string) => {
    const host = c.req.header("host") ?? "localhost";
    const proto = c.req.header("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}/mcp/${token}`;
  };

  app.get("/auth/ai-links", (c) => {
    const rows = db.select().from(sessions).where(and(eq(sessions.user_id, c.get("user").id), eq(sessions.device_name, AI_DEVICE))).all();
    return c.json({ links: rows.map((r) => ({ id: r.id, created_at: r.created_at, last_used_at: r.last_seen_at })) });
  });
  app.post("/auth/ai-links", (c) => {
    const token = auth.startSession(c.get("user").id, AI_DEVICE);
    return c.json({ url: linkFor(c, token) });
  });
  app.delete("/auth/ai-links/:id", (c) => {
    db.delete(sessions).where(and(eq(sessions.id, c.req.param("id")), eq(sessions.user_id, c.get("user").id), eq(sessions.device_name, AI_DEVICE))).run();
    return c.json({ ok: true });
  });

  app.get("/mcp/:token", (c) => c.json({ error: "Use POST (MCP streamable HTTP)." }, 405));
  app.post("/mcp/:token", async (c) => {
    const token = c.req.param("token");
    const user = auth.authenticate(token);
    if (!user) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This AI link was revoked or is wrong." } }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    const batch = Array.isArray(body);
    const replies = (await Promise.all((batch ? body : [body]).map((m) => agents.handle(token, user, m)))).filter(Boolean);
    if (!replies.length) return c.body(null, 202);
    return c.json(batch ? replies : replies[0]);
  });

  app.post("/auth/logout", (c) => {
    auth.logOut(c.get("token"));
    return c.json({ ok: true });
  });

  app.get("/me", (c) => {
    const user = c.get("user");
    const grants = loadGrants(db, user.id);
    const pages = db.select().from(page_shares).where(eq(page_shares.user_id, user.id)).all();
    return c.json({
      user: publicUser(user),
      spaces: [...grants.spaces].map(([id, role]) => ({ id, role })),
      pages: pages.map((p) => ({ id: p.page_id, space_id: p.space_id, role: p.role })),
    } satisfies Me);
  });

  app.post("/auth/claim-legacy", (c) => {
    if (!legacyToken || !sameSecret(c.req.header("x-legacy-token") ?? "", legacyToken)) return c.json({ error: "forbidden" }, 403);
    const user = c.get("user");
    const owned = db.select({ id: space_members.space_id }).from(space_members).all().map((m) => m.id);
    const ownerless = db
      .select({ id: server_records.id })
      .from(server_records)
      .where(and(eq(server_records.table_name, "space"), owned.length ? notInArray(server_records.id, owned) : undefined))
      .all();
    const now = Date.now();
    for (const { id } of ownerless) db.insert(space_members).values({ space_id: id, user_id: user.id, role: "owner", added_at: now }).run();
    if (ownerless.length) hub?.notify([user.id], { type: "access" });
    return c.json({ claimed: ownerless.length });
  });

  // --- sync ---

  /** Everyone who can see something in these workspaces. */
  const audience = (spaceIds: string[]) => {
    if (!spaceIds.length) return [];
    const members = db.select({ id: space_members.user_id }).from(space_members).where(inArray(space_members.space_id, spaceIds)).all();
    const guests = db.select({ id: page_shares.user_id }).from(page_shares).where(inArray(page_shares.space_id, spaceIds)).all();
    return [...members, ...guests].map((u) => u.id);
  };

  app.post("/sync/push", async (c) => {
    const parsed = pushRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const { ops, device_id } = parsed.data;
    const user = c.get("user");
    const { accepted, rejected, spaces } = db.transaction(() => {
      const registry = createRegistry(db);
      const hasMembers = (id: string) => !!db.select({ id: space_members.user_id }).from(space_members).where(eq(space_members.space_id, id)).get();
      const check = checkPush(registry, loadGrants(db, user.id), ops as Op[], hasMembers);
      const now = Date.now();
      for (const id of check.created) db.insert(space_members).values({ space_id: id, user_id: user.id, role: "owner", added_at: now }).run();
      const rows = check.allowed.map(({ table, ...op }) => ({ ...op, table_name: table, received_at: now, space_id: check.spaceOf({ table, ...op }) }));
      let stored = 0;
      for (let i = 0; i < rows.length; i += 500)
        stored += db
          .insert(server_ops)
          .values(rows.slice(i, i + 500))
          .onConflictDoNothing({ target: server_ops.id })
          .returning({ seq: server_ops.seq })
          .all().length;
      for (const op of check.allowed) registry.track(op);
      return { accepted: stored, rejected: check.rejected, spaces: [...new Set(rows.flatMap((r) => (r.space_id ? [r.space_id] : [])))] };
    });
    if (accepted) hub?.notify(audience(spaces), { type: "ops" }, device_id);
    return c.json({ accepted, rejected } satisfies PushResponse);
  });

  app.get("/sync/pull", (c) => {
    const parsed = pullQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
    const { since, limit, device_id } = parsed.data;
    const user = c.get("user");
    const grants = loadGrants(db, user.id);
    const guestSpaces = db
      .selectDistinct({ id: page_shares.space_id })
      .from(page_shares)
      .where(eq(page_shares.user_id, user.id))
      .all()
      .map((r) => r.id)
      .filter((id) => !grants.spaces.has(id));
    const visible = [...grants.spaces.keys(), ...guestSpaces];
    if (!visible.length) return c.json({ ops: [], cursor: since, has_more: false } satisfies PullResponse);
    const rows = db
      .select()
      .from(server_ops)
      .where(and(gt(server_ops.seq, since), inArray(server_ops.space_id, visible)))
      .orderBy(asc(server_ops.seq))
      .limit(limit)
      .all();
    const registry = createRegistry(db);
    // The cursor moves past every scanned row, including this device's own ops, which are not sent back.
    const cursor = rows.at(-1)?.seq ?? since;
    const ops = rows
      .filter((r) => r.device_id !== device_id)
      .filter((r) => grants.spaces.has(r.space_id!) || (r.table_name !== "space" && registry.canRead(grants, r.record_id)))
      .map(({ table_name, record_id, id, path, value, hlc, device_id }) => ({ id, table: table_name, record_id, path, value: value ?? null, hlc, device_id }));
    return c.json({ ops, cursor, has_more: rows.length === limit } satisfies PullResponse);
  });

  // --- sharing ---

  /** A page's or workspace's name from its latest ops, for apps that don't send it. */
  const nameFromOps = (id: string) => {
    for (const op of db.select().from(server_ops).where(eq(server_ops.record_id, id)).orderBy(desc(server_ops.seq)).limit(200).all()) {
      const [a, b] = op.path;
      const v = op.value as unknown;
      if (a === "name" && typeof v === "string") return v;
      if (a === "properties" && b === "title") return plainText(v as RichText);
      if (a === "properties" && !b && v && typeof v === "object" && "title" in v) return plainText((v as { title: RichText }).title);
    }
    return undefined;
  };

  const nameOf = (userId: string) => auth.getUser(userId);

  const spacePeople = (spaceId: string): Person[] => [
    ...db
      .select()
      .from(space_members)
      .where(eq(space_members.space_id, spaceId))
      .all()
      .flatMap((m) => {
        const u = nameOf(m.user_id);
        return u ? [{ user_id: u.id, email: u.email, name: u.name, role: m.role, pending: false }] : [];
      }),
    ...db
      .select()
      .from(invites)
      .where(and(eq(invites.kind, "space"), eq(invites.target_id, spaceId)))
      .all()
      .map((i) => ({ email: i.email, role: i.role, pending: true })),
  ];

  const pagePeople = (pageId: string): Person[] => [
    ...db
      .select()
      .from(page_shares)
      .where(eq(page_shares.page_id, pageId))
      .all()
      .flatMap((s) => {
        const u = nameOf(s.user_id);
        return u ? [{ user_id: u.id, email: u.email, name: u.name, role: s.role, pending: false }] : [];
      }),
    ...db
      .select()
      .from(invites)
      .where(and(eq(invites.kind, "page"), eq(invites.target_id, pageId)))
      .all()
      .map((i) => ({ email: i.email, role: i.role, pending: true })),
  ];

  const invite = (kind: "space" | "page", targetId: string, spaceId: string, email: string, role: Person["role"], by: string, title?: string) => {
    db.delete(invites).where(and(eq(invites.email, email), eq(invites.target_id, targetId))).run();
    db.insert(invites)
      .values({ id: crypto.randomUUID(), email, kind, target_id: targetId, space_id: spaceId, role, invited_by: by, created_at: Date.now(), title: title ?? null })
      .run();
  };

  app.get("/spaces/:id/members", (c) => {
    const id = c.req.param("id");
    if (!loadGrants(db, c.get("user").id).spaces.has(id)) return c.json({ error: "not found" }, 404);
    return c.json({ people: spacePeople(id) });
  });

  app.post("/spaces/:id/members", async (c) => {
    const id = c.req.param("id");
    const me = c.get("user");
    if (loadGrants(db, me.id).spaces.get(id) !== "owner") return c.json({ error: "Only owners can invite people to a workspace." }, 403);
    const parsed = inviteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a valid email." }, 400);
    const { email, role, title } = parsed.data;
    if (email === me.email) return c.json({ error: "You're already in this workspace." }, 400);
    const target = auth.findUser(email);
    if (target) {
      const current = db.select().from(space_members).where(and(eq(space_members.space_id, id), eq(space_members.user_id, target.id))).get();
      if (current?.role === "owner" && role !== "owner" && ownerCount(id) <= 1) return c.json({ error: "A workspace needs at least one owner." }, 400);
      if (!current) addNotification(db, hub, target.id, shareNotification("space", me, title ?? nameFromOps(id), role, id, id));
      db.insert(space_members)
        .values({ space_id: id, user_id: target.id, role, added_at: Date.now() })
        .onConflictDoUpdate({ target: [space_members.space_id, space_members.user_id], set: { role } })
        .run();
      // A page share inside this workspace is now redundant.
      db.delete(page_shares).where(and(eq(page_shares.space_id, id), eq(page_shares.user_id, target.id))).run();
      hub?.notify([target.id], { type: "access" });
    } else invite("space", id, id, email, role, me.id, title ?? nameFromOps(id));
    return c.json({ people: spacePeople(id) });
  });

  const ownerCount = (spaceId: string) =>
    db.select().from(space_members).where(and(eq(space_members.space_id, spaceId), eq(space_members.role, "owner"))).all().length;

  app.delete("/spaces/:id/members", async (c) => {
    const id = c.req.param("id");
    const me = c.get("user");
    const parsed = removePersonSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a valid email." }, 400);
    const { email } = parsed.data;
    const myRole = loadGrants(db, me.id).spaces.get(id);
    if (myRole !== "owner" && email !== me.email) return c.json({ error: "Only owners can remove people." }, 403);
    const target = auth.findUser(email);
    if (target) {
      const member = db.select().from(space_members).where(and(eq(space_members.space_id, id), eq(space_members.user_id, target.id))).get();
      if (member?.role === "owner" && ownerCount(id) <= 1) return c.json({ error: "A workspace needs at least one owner." }, 400);
      db.delete(space_members).where(and(eq(space_members.space_id, id), eq(space_members.user_id, target.id))).run();
      hub?.notify([target.id], { type: "access" });
    }
    db.delete(invites).where(and(eq(invites.email, email), eq(invites.target_id, id))).run();
    return c.json({ people: myRole ? spacePeople(id) : [] });
  });

  /** A shared page, its workspace, and the caller's role there. */
  const pageAccess = (c: Context<Env>) => {
    const id = c.req.param("id") ?? "";
    const registry = createRegistry(db);
    const page = registry.get(id);
    if (!page || page.table_name !== "block" || page.type !== "page" || !page.space_id) return undefined;
    const grants = loadGrants(db, c.get("user").id);
    return { id, spaceId: page.space_id, role: registry.roleOn(grants, id), spaceRole: grants.spaces.get(page.space_id) };
  };

  app.get("/pages/:id/shares", (c) => {
    const page = pageAccess(c);
    if (!page?.role) return c.json({ error: "not found" }, 404);
    return c.json({ people: pagePeople(page.id) });
  });

  app.post("/pages/:id/shares", async (c) => {
    const page = pageAccess(c);
    const me = c.get("user");
    if (!page?.role) return c.json({ error: "not found" }, 404);
    if (!canEdit(page.spaceRole)) return c.json({ error: "Only workspace members who can edit can share pages." }, 403);
    const parsed = inviteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.role === "owner") return c.json({ error: "Enter a valid email and pick Editor or Viewer." }, 400);
    const { email, role, title } = parsed.data;
    if (email === me.email) return c.json({ error: "You can already see this page." }, 400);
    const target = auth.findUser(email);
    if (target) {
      if (loadGrants(db, target.id).spaces.has(page.spaceId)) return c.json({ error: "They're already in this workspace, so they can see this page." }, 409);
      const had = db.select().from(page_shares).where(and(eq(page_shares.page_id, page.id), eq(page_shares.user_id, target.id))).get();
      if (!had) addNotification(db, hub, target.id, shareNotification("page", me, title ?? nameFromOps(page.id), role, page.id, page.spaceId));
      db.insert(page_shares)
        .values({ page_id: page.id, user_id: target.id, space_id: page.spaceId, role, added_at: Date.now() })
        .onConflictDoUpdate({ target: [page_shares.page_id, page_shares.user_id], set: { role } })
        .run();
      hub?.notify([target.id], { type: "access" });
    } else invite("page", page.id, page.spaceId, email, role, me.id, title ?? nameFromOps(page.id));
    return c.json({ people: pagePeople(page.id) });
  });

  app.delete("/pages/:id/shares", async (c) => {
    const page = pageAccess(c);
    const me = c.get("user");
    if (!page?.role) return c.json({ error: "not found" }, 404);
    const parsed = removePersonSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a valid email." }, 400);
    const { email } = parsed.data;
    if (!canEdit(page.spaceRole) && email !== me.email) return c.json({ error: "Only workspace members who can edit can change sharing." }, 403);
    const target = auth.findUser(email);
    if (target) {
      db.delete(page_shares).where(and(eq(page_shares.page_id, page.id), eq(page_shares.user_id, target.id))).run();
      hub?.notify([target.id], { type: "access" });
    }
    db.delete(invites).where(and(eq(invites.email, email), eq(invites.target_id, page.id))).run();
    return c.json({ people: canEdit(page.spaceRole) ? pagePeople(page.id) : [] });
  });

  return { app, auth };
}

/** Before accounts, ops had no workspace; works it out once from the ops themselves. */
export function backfillRegistry(db: Db) {
  if (db.select({ id: server_records.id }).from(server_records).limit(1).get()) return;
  const pending = db.select({ seq: server_ops.seq }).from(server_ops).where(isNull(server_ops.space_id)).limit(1).get();
  if (!pending) return;
  db.transaction(() => {
    const registry = createRegistry(db);
    for (const row of db.select().from(server_ops).orderBy(asc(server_ops.seq)).all())
      registry.track({ ...row, table: row.table_name, value: row.value ?? null });
    for (const r of db.select().from(server_records).all())
      if (r.space_id) db.update(server_ops).set({ space_id: r.space_id }).where(and(eq(server_ops.record_id, r.id), isNull(server_ops.space_id))).run();
  });
}
