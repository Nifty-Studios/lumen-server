// People around the notes: notifications (a page or workspace shared with you, friend
// requests), friends, and each person's spellcheck dictionary. Devices hear about changes over
// the live socket ({type: "inbox" | "friends" | "dictionary"}) and fetch the lists.

import type { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  dictionaryChangeSchema,
  friendRequestSchema,
  markReadSchema,
  uuidv7,
  type Friend,
  type LumenNotification,
  type NotificationKind,
} from "@lumen/shared";
import { dictionary_words, friendships, notifications, users, type UserRow } from "@lumen/shared/schema/server";
import type { Db } from "./db";
import type { Hub } from "./live";

type Env = { Variables: { user: UserRow; token: string } };

const MAX_NOTIFICATIONS = 100;

export interface NewNotification {
  kind: NotificationKind;
  title: string;
  body: string;
  actorId?: string | undefined;
  pageId?: string | undefined;
  spaceId?: string | undefined;
  friendshipId?: string | undefined;
}

/** Stores a notification for someone and tells their open devices. */
export function addNotification(db: Db, hub: Hub | undefined, userId: string, n: NewNotification) {
  db.insert(notifications)
    .values({
      id: uuidv7(),
      user_id: userId,
      kind: n.kind,
      title: n.title,
      body: n.body,
      actor_id: n.actorId ?? null,
      page_id: n.pageId ?? null,
      space_id: n.spaceId ?? null,
      friendship_id: n.friendshipId ?? null,
      created_at: Date.now(),
    })
    .run();
  hub?.notify([userId], { type: "inbox" });
}

const roleWords = (role: string) => (role === "viewer" ? "you can view it" : role === "owner" ? "you're an owner" : "you can edit it");

/** The notification for a page or workspace just shared with someone. */
export function shareNotification(kind: "page" | "space", by: Pick<UserRow, "id" | "name">, title: string | null | undefined, role: string, targetId: string, spaceId: string): NewNotification {
  const name = title?.trim() || (kind === "page" ? "Untitled" : "a workspace");
  return kind === "page"
    ? { kind: "page_shared", title: `${by.name} shared a page with you`, body: `“${name}” · ${roleWords(role)}`, actorId: by.id, pageId: targetId, spaceId }
    : { kind: "space_shared", title: `${by.name} added you to a workspace`, body: `${name} · ${roleWords(role)}`, actorId: by.id, spaceId };
}

export function mountSocial(app: Hono<Env>, db: Db, hub: Hub | undefined) {
  const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name });
  const usersById = (ids: string[]) =>
    new Map((ids.length ? db.select().from(users).where(inArray(users.id, [...new Set(ids)])).all() : []).map((u) => [u.id, u]));

  // --- notifications ---

  const listNotifications = (userId: string): LumenNotification[] => {
    const rows = db.select().from(notifications).where(eq(notifications.user_id, userId)).orderBy(desc(notifications.created_at)).limit(MAX_NOTIFICATIONS).all();
    const actors = usersById(rows.flatMap((r) => (r.actor_id ? [r.actor_id] : [])));
    return rows.map((r) => {
      const actor = r.actor_id ? actors.get(r.actor_id) : undefined;
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        created_at: r.created_at,
        ...(actor ? { actor: publicUser(actor) } : {}),
        ...(r.page_id ? { page_id: r.page_id } : {}),
        ...(r.space_id ? { space_id: r.space_id } : {}),
        ...(r.friendship_id ? { friendship_id: r.friendship_id } : {}),
        ...(r.read_at ? { read_at: r.read_at } : {}),
      };
    });
  };

  app.get("/notifications", (c) => c.json({ notifications: listNotifications(c.get("user").id) }));

  app.post("/notifications/read", async (c) => {
    const parsed = markReadSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const me = c.get("user").id;
    const { ids } = parsed.data;
    db.update(notifications)
      .set({ read_at: Date.now() })
      .where(and(eq(notifications.user_id, me), isNull(notifications.read_at), ids ? inArray(notifications.id, ids.length ? ids : [""]) : undefined))
      .run();
    hub?.notify([me], { type: "inbox" });
    return c.json({ ok: true });
  });

  app.delete("/notifications", (c) => {
    const me = c.get("user").id;
    db.delete(notifications).where(eq(notifications.user_id, me)).run();
    hub?.notify([me], { type: "inbox" });
    return c.json({ ok: true });
  });

  // --- friends ---

  const listFriends = (me: string): Friend[] => {
    const rows = db
      .select()
      .from(friendships)
      .where(or(eq(friendships.requester_id, me), eq(friendships.addressee_id, me)))
      .all();
    const people = usersById(rows.map((r) => (r.requester_id === me ? r.addressee_id : r.requester_id)));
    return rows
      .flatMap((r): Friend[] => {
        const other = people.get(r.requester_id === me ? r.addressee_id : r.requester_id);
        if (!other) return [];
        const status = r.status === "accepted" ? "accepted" : r.requester_id === me ? "outgoing" : "incoming";
        return [{ id: r.id, user: publicUser(other), status, since: r.accepted_at ?? r.created_at }];
      })
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
  };

  const between = (a: string, b: string) =>
    db
      .select()
      .from(friendships)
      .where(
        or(
          and(eq(friendships.requester_id, a), eq(friendships.addressee_id, b)),
          and(eq(friendships.requester_id, b), eq(friendships.addressee_id, a)),
        ),
      )
      .get();

  /** Accepts a request sent to `me`, and tells the person who sent it. */
  const accept = (row: typeof friendships.$inferSelect, me: UserRow) => {
    db.update(friendships).set({ status: "accepted", accepted_at: Date.now() }).where(eq(friendships.id, row.id)).run();
    db.update(notifications)
      .set({ read_at: Date.now() })
      .where(and(eq(notifications.user_id, me.id), eq(notifications.friendship_id, row.id), isNull(notifications.read_at)))
      .run();
    addNotification(db, hub, row.requester_id, {
      kind: "friend_accepted",
      title: `${me.name} accepted your friend request`,
      body: "You can now share with them in one tap.",
      actorId: me.id,
      friendshipId: row.id,
    });
    hub?.notify([row.requester_id, me.id], { type: "friends" });
    hub?.notify([me.id], { type: "inbox" });
  };

  app.get("/friends", (c) => c.json({ friends: listFriends(c.get("user").id) }));

  app.post("/friends", async (c) => {
    const parsed = friendRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a valid email." }, 400);
    const me = c.get("user");
    if (parsed.data.email === me.email) return c.json({ error: "That's your own email." }, 400);
    const other = db.select().from(users).where(eq(users.email, parsed.data.email)).get();
    if (!other) return c.json({ error: "Nobody uses Lumen with that email yet. Share a page with them and they'll get it when they sign up." }, 404);
    const existing = between(me.id, other.id);
    if (existing?.status === "accepted") return c.json({ error: `You and ${other.name} are already friends.` }, 409);
    if (existing && existing.addressee_id === me.id) accept(existing, me);
    else if (!existing) {
      const id = uuidv7();
      db.insert(friendships).values({ id, requester_id: me.id, addressee_id: other.id, status: "pending", created_at: Date.now() }).run();
      addNotification(db, hub, other.id, {
        kind: "friend_request",
        title: `${me.name} wants to be friends`,
        body: `${me.email} · accept to share with each other in one tap`,
        actorId: me.id,
        friendshipId: id,
      });
      hub?.notify([other.id], { type: "friends" });
    }
    return c.json({ friends: listFriends(me.id) });
  });

  app.post("/friends/:id/accept", (c) => {
    const me = c.get("user");
    const row = db.select().from(friendships).where(eq(friendships.id, c.req.param("id"))).get();
    if (!row || row.addressee_id !== me.id) return c.json({ error: "That request is gone." }, 404);
    if (row.status === "pending") accept(row, me);
    return c.json({ friends: listFriends(me.id) });
  });

  app.delete("/friends/:id", (c) => {
    const me = c.get("user");
    const row = db.select().from(friendships).where(eq(friendships.id, c.req.param("id"))).get();
    if (!row || (row.requester_id !== me.id && row.addressee_id !== me.id)) return c.json({ error: "not found" }, 404);
    db.delete(friendships).where(eq(friendships.id, row.id)).run();
    // A request nobody can answer any more shouldn't wait in an inbox.
    db.delete(notifications).where(and(eq(notifications.friendship_id, row.id), eq(notifications.kind, "friend_request"))).run();
    const other = row.requester_id === me.id ? row.addressee_id : row.requester_id;
    hub?.notify([other, me.id], { type: "friends" });
    hub?.notify([other, me.id], { type: "inbox" });
    return c.json({ friends: listFriends(me.id) });
  });

  // --- dictionary ---

  const entries = (userId: string) =>
    db
      .select({ word: dictionary_words.word, meaning: dictionary_words.meaning })
      .from(dictionary_words)
      .where(eq(dictionary_words.user_id, userId))
      .all()
      .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: "base" }));
  const dictionary = (userId: string) => {
    const list = entries(userId);
    return { words: list.map((e) => e.word), entries: list.map((e) => (e.meaning ? { word: e.word, meaning: e.meaning } : { word: e.word })) };
  };

  app.get("/dictionary", (c) => c.json(dictionary(c.get("user").id)));

  app.post("/dictionary", async (c) => {
    const parsed = dictionaryChangeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const me = c.get("user").id;
    const { add = [], remove = [], define = [] } = parsed.data;
    const now = Date.now();
    db.transaction(() => {
      const have = new Map(entries(me).map((e) => [e.word.toLowerCase(), e.word]));
      const insert = (w: string, meaning: string | null = null) => {
        db.insert(dictionary_words).values({ user_id: me, word: w, added_at: now, meaning }).run();
        have.set(w.toLowerCase(), w);
      };
      for (const w of remove) {
        const stored = have.get(w.toLowerCase());
        if (stored) db.delete(dictionary_words).where(and(eq(dictionary_words.user_id, me), eq(dictionary_words.word, stored))).run();
        have.delete(w.toLowerCase());
      }
      for (const w of add) if (!have.has(w.toLowerCase())) insert(w);
      for (const { word, meaning } of define) {
        const stored = have.get(word.toLowerCase());
        if (!stored) insert(word, meaning || null);
        else db.update(dictionary_words).set({ meaning: meaning || null }).where(and(eq(dictionary_words.user_id, me), eq(dictionary_words.word, stored))).run();
      }
    });
    if (add.length || remove.length || define.length) hub?.notify([me], { type: "dictionary" });
    return c.json(dictionary(me));
  });
}
