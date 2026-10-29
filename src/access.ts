// Who may read and write what. Every record belongs to one workspace (space); members of a
// workspace have a role in all of it, and a page shared with someone gives them a role in that
// page and everything under it. The registry (server_records) tracks each record's workspace
// and parent from the ops themselves, so the server never has to materialize records.

import { eq } from "drizzle-orm";
import { canEdit, strongerRole, type Op, type PageRole, type Role, type SpaceRole } from "@lumen/shared";
import { page_shares, server_records, space_members, type ServerRecordRow } from "@lumen/shared/schema/server";
import type { Db } from "./db";

const TRACKED = ["space_id", "parent_id", "parent_table", "type"] as const;
type Tracked = (typeof TRACKED)[number];
const isTracked = (field: string | undefined): field is Tracked => TRACKED.includes(field as Tracked);

export type Place = ServerRecordRow;

const emptyPlace = (op: Pick<Op, "table" | "record_id">): Place => ({
  id: op.record_id,
  table_name: op.table,
  space_id: op.table === "space" ? op.record_id : null,
  parent_id: null,
  parent_table: null,
  type: null,
  clocks: {},
});

/** Folds an op into a record's place (last writer wins per field, as on the clients). */
export function foldOp(place: Place, op: Pick<Op, "path" | "value" | "hlc">): boolean {
  const field = op.path.length === 1 ? op.path[0] : undefined;
  if (!isTracked(field) || place.table_name === "space") return false;
  const clock = place.clocks[field];
  if (clock !== undefined && clock >= op.hlc) return false;
  place[field] = typeof op.value === "string" ? op.value : null;
  place.clocks = { ...place.clocks, [field]: op.hlc };
  return true;
}

/** Roles of one user, loaded once per request. */
export interface Grants {
  spaces: Map<string, SpaceRole>;
  pages: Map<string, PageRole>;
}

export function loadGrants(db: Db, userId: string): Grants {
  const spaces = db.select().from(space_members).where(eq(space_members.user_id, userId)).all();
  const pages = db.select().from(page_shares).where(eq(page_shares.user_id, userId)).all();
  return { spaces: new Map(spaces.map((m) => [m.space_id, m.role])), pages: new Map(pages.map((p) => [p.page_id, p.role])) };
}

export function createRegistry(db: Db) {
  const cache = new Map<string, Place | null>();

  function get(id: string): Place | undefined {
    if (!cache.has(id)) cache.set(id, db.select().from(server_records).where(eq(server_records.id, id)).get() ?? null);
    return cache.get(id) ?? undefined;
  }

  /** Records an accepted op's effect on where its record lives. */
  function track(op: Op) {
    const existing = get(op.record_id);
    const place = existing ? { ...existing } : emptyPlace(op);
    const changed = foldOp(place, op);
    if (existing && !changed) return;
    db.insert(server_records)
      .values(place)
      .onConflictDoUpdate({ target: server_records.id, set: { ...place } })
      .run();
    cache.set(op.record_id, place);
  }

  /**
   * The role a user has on a record: their workspace role, or a share on the record or any
   * page above it, whichever is stronger. `lookup` can supply records not stored yet.
   */
  function roleOn(grants: Grants, id: string, lookup: (id: string) => Place | undefined = get): Role | undefined {
    const place = lookup(id);
    if (!place?.space_id) return undefined;
    if (place.table_name === "space") return grants.spaces.get(place.id);
    let role: Role | undefined = grants.spaces.get(place.space_id);
    if (role === "owner" || !grants.pages.size) return role;
    const seen = new Set<string>();
    for (let cur: Place | undefined = place; cur && !seen.has(cur.id); ) {
      seen.add(cur.id);
      role = strongerRole(role, grants.pages.get(cur.id));
      cur = cur.parent_table === "block" && cur.parent_id ? lookup(cur.parent_id) : undefined;
    }
    return role;
  }

  return { get, track, roleOn, canRead: (g: Grants, id: string) => !!roleOn(g, id), canWrite: (g: Grants, id: string) => canEdit(roleOn(g, id)) };
}

export type Registry = ReturnType<typeof createRegistry>;

/**
 * Splits a pushed batch into allowed and rejected ops. Records created in the batch are
 * judged by where the batch puts them; a workspace created in the batch belongs to its creator.
 */
export function checkPush(registry: Registry, grants: Grants, ops: Op[], hasMembers: (spaceId: string) => boolean) {
  const pending = new Map<string, Place>();
  for (const op of ops) {
    if (registry.get(op.record_id)) continue;
    const place = pending.get(op.record_id) ?? emptyPlace(op);
    foldOp(place, op);
    pending.set(op.record_id, place);
  }
  const lookup = (id: string) => registry.get(id) ?? pending.get(id);

  // New workspaces (never seen, nobody in them) belong to whoever creates them.
  const created = new Set<string>();
  for (const [id, place] of pending) if (place.table_name === "space" && !hasMembers(id)) created.add(id);
  const effective: Grants = { spaces: new Map(grants.spaces), pages: grants.pages };
  for (const id of created) effective.spaces.set(id, "owner");

  const allowed: Op[] = [];
  const rejected: string[] = [];
  for (const op of ops) {
    const place = lookup(op.record_id);
    let ok = !!place && canEdit(registry.roleOn(effective, op.record_id, lookup));
    const field = op.path.length === 1 ? op.path[0] : undefined;
    if (ok && place && op.table === "space" && field === "alive" && op.value === false)
      ok = effective.spaces.get(place.id) === "owner"; // only owners delete a workspace
    if (ok && field === "space_id") {
      const stored = registry.get(op.record_id);
      ok = !stored?.space_id || stored.space_id === op.value; // a record never changes workspace
    }
    if (ok && field === "parent_id" && typeof op.value === "string" && place?.table_name !== "space") {
      // Moving something requires edit rights where it lands, too.
      const target = lookup(op.value);
      ok = target ? canEdit(registry.roleOn(effective, op.value, lookup)) : canEdit(effective.spaces.get(place?.space_id ?? ""));
    }
    if (ok) allowed.push(op);
    else rejected.push(op.id);
  }
  return { allowed, rejected, created, spaceOf: (op: Op) => lookup(op.record_id)?.space_id ?? null };
}
