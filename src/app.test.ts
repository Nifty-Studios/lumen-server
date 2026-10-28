import { describe, expect, it } from "bun:test";
import { formatHlc, type Op, type PullResponse } from "@lumen/shared";
import { createApp } from "./app";
import { openDb } from "./db";

const TOKEN = "t".repeat(32);
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const op = (id: string, device: string, wall: number): Op => ({
  id,
  table: "block",
  record_id: "b1",
  path: ["alive"],
  value: true,
  hlc: formatHlc({ wall, counter: 0, deviceId: device }),
  device_id: device,
});

const setup = () => createApp(openDb(":memory:"), TOKEN);

const pull = async (app: ReturnType<typeof setup>, query: string) =>
  (await (await app.request(`/sync/pull?${query}`, { headers: auth })).json()) as PullResponse;

const push = (app: ReturnType<typeof setup>, device: string, ops: Op[]) =>
  app.request("/sync/push", { method: "POST", headers: auth, body: JSON.stringify({ device_id: device, ops }) });

describe("sync server", () => {
  it("rejects requests without the token", async () => {
    const app = setup();
    expect((await app.request("/sync/pull")).status).toBe(401);
    expect((await app.request("/sync/pull", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/health")).status).toBe(200);
  });

  it("stores ops idempotently and relays them to other devices", async () => {
    const app = setup();
    expect(await (await push(app, "a", [op("1", "a", 1), op("2", "a", 2)])).json()).toEqual({ accepted: 2 });
    expect(await (await push(app, "a", [op("2", "a", 2)])).json()).toEqual({ accepted: 0 });
    await push(app, "b", [op("3", "b", 3)]);

    const forB = await pull(app, "since=0&device_id=b");
    expect(forB.ops.map((o: Op) => o.id)).toEqual(["1", "2"]);
    expect(forB.has_more).toBe(false);
    // Cursors only increase (they may skip numbers); nothing is left after the last one.
    const after = await pull(app, `since=${forB.cursor}&device_id=b`);
    expect(after.ops).toEqual([]);

    const forA = await pull(app, "since=0&device_id=a");
    expect(forA.ops).toEqual([op("3", "b", 3)]);
  });

  it("pages with the cursor", async () => {
    const app = setup();
    await push(app, "a", [op("1", "a", 1), op("2", "a", 2), op("3", "a", 3)]);
    const first = await pull(app, "since=0&limit=2");
    expect(first.ops).toHaveLength(2);
    expect(first.has_more).toBe(true);
    const rest = await pull(app, `since=${first.cursor}&limit=2`);
    expect(rest.ops.map((o: Op) => o.id)).toEqual(["3"]);
  });

  it("rejects malformed pushes", async () => {
    const res = await setup().request("/sync/push", { method: "POST", headers: auth, body: JSON.stringify({ ops: [{ id: 1 }] }) });
    expect(res.status).toBe(400);
  });
});
