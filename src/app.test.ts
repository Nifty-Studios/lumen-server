import { describe, expect, it } from "bun:test";
import { formatHlc, type Json, type LiveMessage, type Me, type Op, type Person, type PullResponse, type PushResponse } from "@lumen/shared";
import { server_ops } from "@lumen/shared/schema/server";
import { backfillRegistry, createApp } from "./app";
import { openDb } from "./db";
import type { Hub } from "./live";

const LEGACY = "l".repeat(32);

function setup() {
  const db = openDb(":memory:");
  const sent: { users: string[]; msg: LiveMessage; except?: string }[] = [];
  const hub = { notify: (users: Iterable<string>, msg: LiveMessage, except?: string) => sent.push({ users: [...users], msg, except }) } as unknown as Hub;
  const { app } = createApp(db, { hub, legacyToken: LEGACY });
  const call = async <T>(token: string | null, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const signUp = async (email: string, name = email.split("@")[0]!) =>
    (await call<{ token: string; user: { id: string } }>(null, "POST", "/auth/signup", { email, password: "correct horse", name, device_name: "test" })).body;
  return { db, app, call, signUp, sent };
}

let wall = 1;
const fieldsOps = (table: Op["table"], id: string, fields: Record<string, Json>, device: string): Op[] =>
  Object.entries(fields).map(([k, v]) => ({
    id: crypto.randomUUID(),
    table,
    record_id: id,
    path: [k],
    value: v,
    hlc: formatHlc({ wall: wall++, counter: 0, deviceId: device }),
    device_id: device,
  }));
const newSpace = (id: string, device: string) => fieldsOps("space", id, { name: "Home", pages: [], alive: true }, device);
const newBlock = (id: string, space: string, parent: string, device: string, type = "text", parentTable = "block") =>
  fieldsOps("block", id, { space_id: space, parent_id: parent, parent_table: parentTable, type, alive: true }, device);
const edit = (id: string, device: string, title = "hi") => fieldsOps("block", id, { properties: { title: [{ text: title }] } }, device);

type Api = ReturnType<typeof setup>;
const push = (api: Api, token: string, device: string, ops: Op[]) => api.call<PushResponse>(token, "POST", "/sync/push", { device_id: device, ops });
const pull = async (api: Api, token: string, device = "other", since = 0) =>
  (await api.call<PullResponse>(token, "GET", `/sync/pull?since=${since}&device_id=${device}`)).body;
const me = async (api: Api, token: string) => (await api.call<Me>(token, "GET", "/me")).body;

/** A's workspace S with a top-level page P (one text block T) and another page Q. */
async function workspace(api: Api) {
  const a = await api.signUp("a@lumen.test");
  const ops = [
    ...newSpace("S", "a1"),
    ...newBlock("P", "S", "S", "a1", "page", "space"),
    ...newBlock("T", "S", "P", "a1"),
    ...newBlock("Q", "S", "S", "a1", "page", "space"),
  ];
  expect((await push(api, a.token, "a1", ops)).body).toEqual({ accepted: ops.length, rejected: [] });
  return { a, ops };
}

describe("accounts", () => {
  it("signs up, logs in and out, and guards everything else", async () => {
    const api = setup();
    expect((await api.call(null, "GET", "/health")).status).toBe(200);
    expect((await api.call(null, "GET", "/sync/pull")).status).toBe(401);
    expect((await api.call("nope", "GET", "/me")).status).toBe(401);

    const { token } = await api.signUp("Ada@Lumen.test", "Ada");
    expect((await me(api, token)).user).toMatchObject({ email: "ada@lumen.test", name: "Ada" });
    expect((await api.call(null, "POST", "/auth/signup", { email: "ada@lumen.test", password: "another pass", name: "A", device_name: "x" })).status).toBe(409);
    expect((await api.call(null, "POST", "/auth/signup", { email: "b@lumen.test", password: "short", name: "B", device_name: "x" })).status).toBe(400);

    expect((await api.call(null, "POST", "/auth/login", { email: "ada@lumen.test", password: "wrong pass", device_name: "x" })).status).toBe(401);
    const login = await api.call<{ token: string }>(null, "POST", "/auth/login", { email: "ADA@lumen.test", password: "correct horse", device_name: "phone" });
    expect(login.status).toBe(200);
    expect(login.body.token).not.toBe(token);

    await api.call(token, "POST", "/auth/logout");
    expect((await api.call(token, "GET", "/me")).status).toBe(401);
    expect((await api.call(login.body.token, "GET", "/me")).status).toBe(200);
  });

  it("slows down repeated wrong passwords", async () => {
    const api = setup();
    await api.signUp("a@lumen.test");
    const attempt = () => api.call(null, "POST", "/auth/login", { email: "a@lumen.test", password: "wrong pass", device_name: "x" });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });
});

describe("sync", () => {
  it("gives a new workspace to its creator and relays it only to their devices", async () => {
    const api = setup();
    const { a, ops } = await workspace(api);
    expect((await me(api, a.token)).spaces).toEqual([{ id: "S", role: "owner" }]);
    expect((await pull(api, a.token, "a2")).ops).toHaveLength(ops.length);
    expect((await pull(api, a.token, "a1")).ops).toHaveLength(0); // its own ops aren't sent back

    const b = await api.signUp("b@lumen.test");
    expect((await pull(api, b.token)).ops).toHaveLength(0);
    const sneaky = edit("T", "b1");
    expect((await push(api, b.token, "b1", sneaky)).body).toEqual({ accepted: 0, rejected: sneaky.map((o) => o.id) });
    // Nor can anyone claim the workspace by "creating" it again.
    const takeover = newSpace("S", "b1");
    expect((await push(api, b.token, "b1", takeover)).body.rejected).toHaveLength(takeover.length);
  });

  it("stores ops idempotently and tells the workspace's other devices", async () => {
    const api = setup();
    const { a } = await workspace(api);
    api.sent.length = 0;
    const ops = edit("T", "a1");
    expect((await push(api, a.token, "a1", ops)).body.accepted).toBe(1);
    expect((await push(api, a.token, "a1", ops)).body.accepted).toBe(0);
    expect(api.sent).toEqual([{ users: [a.user.id], msg: { type: "ops" }, except: "a1" }]);
  });
});

describe("workspace sharing", () => {
  it("lets owners invite viewers and editors, and enforces their roles", async () => {
    const api = setup();
    const { a } = await workspace(api);
    const b = await api.signUp("b@lumen.test");

    const invited = await api.call<{ people: Person[] }>(a.token, "POST", "/spaces/S/members", { email: "b@lumen.test", role: "viewer" });
    expect(invited.body.people.map((p) => [p.email, p.role])).toEqual([
      ["a@lumen.test", "owner"],
      ["b@lumen.test", "viewer"],
    ]);
    expect(api.sent.at(-1)).toMatchObject({ users: [b.user.id], msg: { type: "access" } });
    expect((await me(api, b.token)).spaces).toEqual([{ id: "S", role: "viewer" }]);
    expect((await pull(api, b.token)).ops.length).toBeGreaterThan(0);

    const tryEdit = edit("T", "b1");
    expect((await push(api, b.token, "b1", tryEdit)).body.rejected).toEqual(tryEdit.map((o) => o.id));
    expect((await api.call(b.token, "POST", "/spaces/S/members", { email: "c@lumen.test", role: "editor" })).status).toBe(403);

    await api.call(a.token, "POST", "/spaces/S/members", { email: "b@lumen.test", role: "editor" });
    expect((await push(api, b.token, "b1", edit("T", "b1", "edited by b"))).body.accepted).toBe(1);
    // Editors can't delete the workspace.
    const del = fieldsOps("space", "S", { alive: false }, "b1");
    expect((await push(api, b.token, "b1", del)).body.rejected).toHaveLength(1);

    // Removed members lose access; the last owner can't be removed.
    await api.call(a.token, "DELETE", "/spaces/S/members", { email: "b@lumen.test" });
    expect((await me(api, b.token)).spaces).toEqual([]);
    expect((await pull(api, b.token)).ops).toHaveLength(0);
    expect((await api.call(a.token, "DELETE", "/spaces/S/members", { email: "a@lumen.test" })).status).toBe(400);
  });

  it("keeps invites for emails without an account until they sign up", async () => {
    const api = setup();
    const { a } = await workspace(api);
    const res = await api.call<{ people: Person[] }>(a.token, "POST", "/spaces/S/members", { email: "new@lumen.test", role: "editor" });
    expect(res.body.people.find((p) => p.email === "new@lumen.test")).toEqual({ email: "new@lumen.test", role: "editor", pending: true });
    const c = await api.signUp("new@lumen.test");
    expect((await me(api, c.token)).spaces).toEqual([{ id: "S", role: "editor" }]);
    const people = await api.call<{ people: Person[] }>(a.token, "GET", "/spaces/S/members");
    expect(people.body.people.every((p) => !p.pending)).toBe(true);
  });
});

describe("page sharing", () => {
  it("shares one page and what's under it, nothing else", async () => {
    const api = setup();
    const { a } = await workspace(api);
    const b = await api.signUp("b@lumen.test");
    expect((await api.call(a.token, "POST", "/pages/P/shares", { email: "b@lumen.test", role: "editor" })).status).toBe(200);
    expect((await me(api, b.token)).pages).toEqual([{ id: "P", space_id: "S", role: "editor" }]);

    const seen = new Set((await pull(api, b.token)).ops.map((o) => o.record_id));
    expect([...seen].sort()).toEqual(["P", "T"]);

    // Writing inside the page is fine; outside it, or moving things out of it, is not.
    expect((await push(api, b.token, "b1", [...newBlock("N", "S", "P", "b1"), ...edit("T", "b1")])).body.rejected).toEqual([]);
    const outside = newBlock("X", "S", "Q", "b1");
    expect((await push(api, b.token, "b1", outside)).body.rejected).toHaveLength(outside.length);
    const topLevel = newBlock("Y", "S", "S", "b1", "page", "space");
    expect((await push(api, b.token, "b1", topLevel)).body.rejected).toHaveLength(topLevel.length);
    const move = fieldsOps("block", "T", { parent_id: "Q" }, "b1");
    expect((await push(api, b.token, "b1", move)).body.rejected).toHaveLength(1);

    // Viewers read only; only workspace editors share pages.
    await api.call(a.token, "POST", "/pages/P/shares", { email: "b@lumen.test", role: "viewer" });
    expect((await push(api, b.token, "b1", edit("T", "b1"))).body.rejected).toHaveLength(1);
    expect((await api.call(b.token, "POST", "/pages/P/shares", { email: "c@lumen.test", role: "viewer" })).status).toBe(403);
    expect((await api.call(a.token, "POST", "/pages/P/shares", { email: "b@lumen.test", role: "owner" })).status).toBe(400);

    // Taking it back.
    await api.call(a.token, "DELETE", "/pages/P/shares", { email: "b@lumen.test" });
    expect((await me(api, b.token)).pages).toEqual([]);
    expect((await pull(api, b.token)).ops).toHaveLength(0);
  });
});

describe("before accounts", () => {
  it("works out old ops' workspaces and lets the legacy token's holder claim them", async () => {
    const api = setup();
    const old = [...newSpace("L", "d1"), ...newBlock("LP", "L", "L", "d1", "page", "space")];
    api.db
      .insert(server_ops)
      .values(old.map(({ table, ...op }, i) => ({ ...op, table_name: table, received_at: i })))
      .run();
    backfillRegistry(api.db);

    const a = await api.signUp("a@lumen.test");
    expect((await pull(api, a.token)).ops).toHaveLength(0);
    expect((await api.call(a.token, "POST", "/auth/claim-legacy", undefined)).status).toBe(403);
    const res = await api.app.request("/auth/claim-legacy", { method: "POST", headers: { authorization: `Bearer ${a.token}`, "x-legacy-token": LEGACY } });
    expect(await res.json()).toEqual({ claimed: 1 });
    expect((await me(api, a.token)).spaces).toEqual([{ id: "L", role: "owner" }]);
    expect((await pull(api, a.token)).ops).toHaveLength(old.length);

    const b = await api.signUp("b@lumen.test");
    const again = await api.app.request("/auth/claim-legacy", { method: "POST", headers: { authorization: `Bearer ${b.token}`, "x-legacy-token": LEGACY } });
    expect(await again.json()).toEqual({ claimed: 0 });
  });
});
