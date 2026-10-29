// Real clients (@lumen/shared/client over in-memory SQLite) against this server in-process:
// sign-in, sync between devices, sharing and its limits, and the move from the old shared token.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AccountSwitchError, createLumen, pageTitle, type Lumen, type RemoteUpdate, type SqlDriver } from "@lumen/shared/client";
import { ops as clientOps } from "@lumen/shared/schema/client";
import { server_ops } from "@lumen/shared/schema/server";
import { backfillRegistry, createApp } from "./app";
import { openDb } from "./db";

const LEGACY = "l".repeat(32);
const PASSWORD = "correct horse";

function bunDriver(): SqlDriver {
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

function world() {
  const db = openDb(":memory:");
  const { app } = createApp(db, { legacyToken: LEGACY });
  const net = { online: true };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!net.online) throw new TypeError("fetch failed");
    return app.request(String(input), init);
  }) as typeof globalThis.fetch;
  const device = (name: string, legacyToken?: string) =>
    createLumen(bunDriver(), { server: { url: "https://sync.test", deviceName: name, fetch, legacyToken } });
  return { db, device, net };
}

const titles = async (lumen: Lumen) => (await lumen.pageTree((await lumen.getSpace())!)).map((n) => pageTitle(n.page));
const para = (id: string, text: string) => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });

/** First launch through sign-up (or log-in) and connect, as the apps do it. */
async function signIn(lumen: Lumen, email: string, mode: "signup" | "login" = "signup") {
  expect(await lumen.start()).toEqual({ needsAuth: true });
  if (mode === "signup") await lumen.signUp({ email, password: PASSWORD, name: email.split("@")[0]! });
  else await lumen.logIn({ email, password: PASSWORD });
  return lumen;
}

describe("devices on one account", () => {
  it("joins the same workspace and keeps both in step", async () => {
    const w = world();
    const desktop = await signIn(w.device("desktop"), "ada@lumen.test");
    const space = (await desktop.getSpace())!;
    const id = await desktop.createPage(space, null);
    await desktop.renamePage(id, "Plans");
    await desktop.sync!.sync();

    // The phone logs in to the same account: same workspace, no second welcome page.
    const phone = await signIn(w.device("phone"), "ada@lumen.test", "login");
    expect((await phone.getSpace())!.id).toBe(space.id);
    expect(await titles(phone)).toEqual(["Welcome to Lumen", "Plans"]);

    // Concurrent edits to one field: the later HLC wins on both devices.
    await desktop.renamePage(id, "Plans (desktop)");
    await new Promise((r) => setTimeout(r, 2));
    await phone.renamePage(id, "Plans (phone)");
    for (const d of [desktop, phone, desktop]) await d.sync!.sync();
    expect(await titles(desktop)).toEqual(["Welcome to Lumen", "Plans (phone)"]);
    expect(await titles(phone)).toEqual(["Welcome to Lumen", "Plans (phone)"]);
    expect(phone.sync!.current.state).toBe("idle");
  });

  it("shows another device's edits in an open page, without touching unsaved local ones", async () => {
    const w = world();
    const desktop = await signIn(w.device("desktop"), "ada@lumen.test");
    const pageId = await desktop.createPage((await desktop.getSpace())!, null);
    await (await desktop.openPage(pageId)).save([para("a", "one"), para("b", "two")] as never);
    await desktop.sync!.sync();
    const phone = await signIn(w.device("phone"), "ada@lumen.test", "login");

    const open = await desktop.openPage(pageId);
    const updates: RemoteUpdate[] = [];
    open.onRemote((u) => updates.push(u));
    await (await phone.openPage(pageId)).save([para("a", "one (phone)"), para("b", "two")] as never);
    await phone.sync!.sync();
    await desktop.sync!.sync();
    await open.save([]).catch(() => {}); // flushes the session queue
    expect(updates.at(-1)?.changed).toEqual(["a"]);
    expect(JSON.stringify(updates.at(-1)?.doc)).toContain("one (phone)");

    // The desktop editor then saves its own change to b: both edits survive.
    await open.save([para("a", "one (phone)"), para("b", "two (desktop)")] as never);
    await desktop.sync!.sync();
    await phone.sync!.sync();
    const texts = async (l: Lumen) => [...(await l.loadPageBlocks(pageId)).values()].map((b) => b.properties.title?.[0]?.text).sort();
    for (const l of [desktop, phone]) expect(await texts(l)).toEqual(["one (phone)", "two (desktop)"]);
    open.close();
  });

  it("drops an unused first-launch workspace when signing in later", async () => {
    const w = world();
    await signIn(w.device("desktop"), "ada@lumen.test");
    const later = w.device("phone");
    expect(await later.start()).toEqual({ needsAuth: true });
    await later.continueSignedOut();
    expect(later.account.skipped).toBe(true);
    expect(later.account.reminderDue()).toBe(false); // not right away
    const local = (await later.getSpace())!.id;

    await later.logIn({ email: "ada@lumen.test", password: PASSWORD });
    const spaces = await later.listSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0]!.space.id).not.toBe(local);
  });

  it("keeps the last account's notes on the device, and swaps them when someone else signs in", async () => {
    const w = world();
    const desk = await signIn(w.device("desktop"), "ada@lumen.test");
    const adaPage = await desk.createPage((await desk.getSpace())!, null);
    await desk.renamePage(adaPage, "Ada's page");
    await desk.sync!.sync();
    const bo = await signIn(w.device("bo's phone"), "bo@lumen.test");
    await bo.renamePage(await bo.createPage((await bo.getSpace())!, null), "Bo's page");
    await bo.sync!.sync();

    // Ada signs out: her notes stay and keep working offline; nothing syncs.
    await desk.signOut();
    expect(desk.account.current).toBeUndefined();
    expect(await titles(desk)).toEqual(["Welcome to Lumen", "Ada's page"]);
    await desk.renamePage(adaPage, "Ada's page (offline edit)");
    expect(await desk.start()).toEqual({ needsAuth: false });

    // Bo signs in while offline: Ada's unsent edit can't be delivered, so nothing is replaced.
    w.net.online = false;
    const offline = await desk.logIn({ email: "bo@lumen.test", password: PASSWORD }).catch((e) => e);
    expect(offline).toMatchObject({ status: 0 }); // AccountError: can't reach the server to log in
    expect(await titles(desk)).toEqual(["Welcome to Lumen", "Ada's page (offline edit)"]);
    w.net.online = true;

    // Online: Ada's edit goes to her account first, then the device holds Bo's notes only.
    await desk.logIn({ email: "bo@lumen.test", password: PASSWORD });
    expect(desk.account.current?.user.email).toBe("bo@lumen.test");
    expect(await titles(desk)).toEqual(["Welcome to Lumen", "Bo's page"]);
    expect(await desk.getBlock(adaPage)).toBeUndefined();
    const adaPhone = await signIn(w.device("ada's phone"), "ada@lumen.test", "login");
    expect(await titles(adaPhone)).toEqual(["Welcome to Lumen", "Ada's page (offline edit)"]);

    // And back: Ada signs in again and her notes return.
    await desk.signOut();
    await desk.logIn({ email: "ada@lumen.test", password: PASSWORD });
    expect(await titles(desk)).toEqual(["Welcome to Lumen", "Ada's page (offline edit)"]);
  });

  it("asks before dropping the previous account's unsent changes", async () => {
    const w = world();
    const desk = await signIn(w.device("desktop"), "ada@lumen.test");
    await desk.sync!.sync();
    await signIn(w.device("bo's phone"), "bo@lumen.test");
    await desk.signOut();
    await desk.renamePage((await desk.pageTree((await desk.getSpace())!))[0]!.page.id, "Unsent");
    // Ada's session has ended elsewhere, so her change can't be delivered.
    await w.db.delete((await import("@lumen/shared/schema/server")).sessions).run();

    const err = await desk.logIn({ email: "bo@lumen.test", password: PASSWORD }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountSwitchError);
    expect(err).toMatchObject({ pending: 2, owner: "ada@lumen.test" });
    expect(desk.account.current).toBeUndefined();
    expect(await titles(desk)).toEqual(["Unsent"]);

    await desk.logIn({ email: "bo@lumen.test", password: PASSWORD }, { discardUnsent: true });
    expect(await titles(desk)).toEqual(["Welcome to Lumen"]);
    expect(await desk.unsyncedCount()).toBe(0);
  });
});

describe("sharing", () => {
  it("shares a workspace with roles", async () => {
    const w = world();
    const ada = await signIn(w.device("ada"), "ada@lumen.test");
    const space = (await ada.getSpace())!;
    await ada.sync!.sync();
    const bo = await signIn(w.device("bo"), "bo@lumen.test");
    expect((await bo.listSpaces()).map((s) => s.role)).toEqual(["owner"]); // their own

    await ada.account.invite(space.id, { email: "bo@lumen.test", role: "viewer" });
    await bo.sync!.sync(); // a real device hears {type: "access"} over the live socket
    await bo.connect();
    const theirs = (await bo.listSpaces()).find((s) => s.space.id === space.id);
    expect(theirs?.role).toBe("viewer");
    const welcome = (await bo.pageTree(theirs!.space))[0]!.page;
    expect(await bo.roleOf(welcome.id)).toBe("viewer");

    // A viewer's edit (the apps prevent it; this is the server's word on it) is refused.
    const refused: string[][] = [];
    bo.onSyncRejected((ids) => refused.push(ids));
    await bo.renamePage(welcome.id, "Mine now");
    await bo.sync!.sync();
    expect(refused.flat().length).toBeGreaterThan(0);
    await ada.sync!.sync();
    expect(await titles(ada)).toEqual(["Welcome to Lumen"]);

    // Removed: the workspace disappears from Bo's device.
    await ada.account.removeMember(space.id, "bo@lumen.test");
    await bo.connect();
    expect((await bo.listSpaces()).map((s) => s.space.id)).not.toContain(space.id);
    expect(await bo.getBlock(welcome.id)).toBeUndefined();
  });

  it("shares a single page as editor, and only that page", async () => {
    const w = world();
    const ada = await signIn(w.device("ada"), "ada@lumen.test");
    const space = (await ada.getSpace())!;
    const shared = await ada.createPage(space, null);
    await ada.renamePage(shared, "Trip");
    const child = await ada.createPage(space, shared);
    await ada.renamePage(child, "Packing list");
    const secret = await ada.createPage(space, null);
    await ada.renamePage(secret, "Diary");
    await ada.sync!.sync();

    // Invited before having an account: applied at sign-up.
    await ada.account.sharePage(shared, { email: "bo@lumen.test", role: "editor" });
    const bo = await signIn(w.device("bo"), "bo@lumen.test");
    const sharedWithBo = await bo.sharedPages();
    expect(sharedWithBo.map((s) => [pageTitle(s.page), s.role])).toEqual([["Trip", "editor"]]);
    expect(pageTitle((await bo.getBlock(child))!)).toBe("Packing list");
    expect(await bo.getBlock(secret)).toBeUndefined();
    expect(await bo.roleOf(child)).toBe("editor");

    // Bo edits inside it, and Ada sees it.
    await bo.renamePage(child, "Packing list (Bo)");
    await bo.sync!.sync();
    await ada.sync!.sync();
    expect(pageTitle((await ada.getBlock(child))!)).toBe("Packing list (Bo)");

    await ada.account.unsharePage(shared, "bo@lumen.test");
    await bo.connect();
    expect(await bo.sharedPages()).toEqual([]);
    expect(await bo.getBlock(child)).toBeUndefined();
  });
});

describe("from the shared token to accounts", () => {
  it("lets the first account claim the workspaces stored before accounts", async () => {
    const w = world();
    // Before: a device synced with the old shared token. The server has its ops, with no owner.
    const old = w.device("old desktop", LEGACY);
    await old.start();
    await old.continueSignedOut();
    const space = (await old.getSpace())!;
    const rows = await old.db.select().from(clientOps);
    w.db
      .insert(server_ops)
      .values(rows.map((r, i) => ({ ...r, table_name: r.table_name, received_at: i, value: r.value ?? null })))
      .run();
    await old.db.update(clientOps).set({ synced: true });
    backfillRegistry(w.db);

    // Now it signs in: the old workspace becomes the account's, and other devices get it.
    await old.signUp({ email: "ada@lumen.test", password: PASSWORD, name: "Ada" });
    expect((await old.listSpaces()).map((s) => [s.space.id, s.role])).toEqual([[space.id, "owner"]]);
    const phone = await signIn(w.device("phone"), "ada@lumen.test", "login");
    expect((await phone.getSpace())!.id).toBe(space.id);
  });
});
