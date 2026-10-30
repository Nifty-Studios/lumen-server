// Accounts and sessions. Passwords are hashed with argon2id (Bun.password); each signed-in
// device gets its own random bearer token, of which only a sha256 hash is stored.

import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { uuidv7 } from "@lumen/shared";
import { invites, page_shares, sessions, space_members, users, type UserRow } from "@lumen/shared/schema/server";
import type { Db } from "./db";
import { shareNotification, type NewNotification } from "./social";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** Session activity is recorded at most this often. */
const SEEN_EVERY = 3_600_000;

export function createAuth(db: Db, notify: (userId: string, n: NewNotification) => void = () => {}) {
  // Verifying against a real hash when the email is unknown keeps both answers equally slow.
  const dummyHash = Bun.password.hashSync("lumen-dummy-password");

  function startSession(userId: string, deviceName: string) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    db.insert(sessions)
      .values({ id: uuidv7(), user_id: userId, token_hash: hashToken(token), device_name: deviceName, created_at: now, last_seen_at: now })
      .run();
    return token;
  }

  /** Turns invites waiting for this email into memberships and page shares. */
  function acceptInvites(user: UserRow): void {
    const waiting = db.select().from(invites).where(eq(invites.email, user.email)).all();
    const now = Date.now();
    for (const inv of waiting) {
      if (inv.kind === "space")
        db.insert(space_members).values({ space_id: inv.target_id, user_id: user.id, role: inv.role, added_at: now }).onConflictDoNothing().run();
      else
        db.insert(page_shares)
          .values({ page_id: inv.target_id, user_id: user.id, space_id: inv.space_id, role: inv.role === "viewer" ? "viewer" : "editor", added_at: now })
          .onConflictDoNothing()
          .run();
      db.delete(invites).where(eq(invites.id, inv.id)).run();
      const by = db.select().from(users).where(eq(users.id, inv.invited_by)).get();
      if (by) notify(user.id, shareNotification(inv.kind, by, inv.title, inv.role, inv.target_id, inv.space_id));
    }
  }

  async function signUp(input: { email: string; password: string; name: string; device_name: string }) {
    if (db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get()) return null;
    const user: UserRow = {
      id: uuidv7(),
      email: input.email,
      name: input.name,
      password_hash: await Bun.password.hash(input.password),
      created_at: Date.now(),
    };
    db.insert(users).values(user).run();
    acceptInvites(user);
    return { user, token: startSession(user.id, input.device_name) };
  }

  async function logIn(input: { email: string; password: string; device_name: string }) {
    const user = db.select().from(users).where(eq(users.email, input.email)).get();
    const ok = await Bun.password.verify(input.password, user?.password_hash ?? dummyHash);
    if (!user || !ok) return null;
    acceptInvites(user);
    return { user, token: startSession(user.id, input.device_name) };
  }

  /** The user behind a bearer token, or undefined. */
  function authenticate(token: string): UserRow | undefined {
    if (!token) return undefined;
    const session = db.select().from(sessions).where(eq(sessions.token_hash, hashToken(token))).get();
    if (!session) return undefined;
    const now = Date.now();
    if (now - session.last_seen_at > SEEN_EVERY) db.update(sessions).set({ last_seen_at: now }).where(eq(sessions.id, session.id)).run();
    return db.select().from(users).where(eq(users.id, session.user_id)).get();
  }

  const logOut = (token: string) => db.delete(sessions).where(eq(sessions.token_hash, hashToken(token))).run();

  const findUser = (email: string) => db.select().from(users).where(eq(users.email, email)).get();
  const getUser = (id: string) => db.select().from(users).where(eq(users.id, id)).get();

  return { signUp, logIn, logOut, authenticate, findUser, getUser, acceptInvites, startSession };
}

export type Auth = ReturnType<typeof createAuth>;

/** Failed sign-in attempts per IP and email, counted in memory over a window. */
export function createLimiter({ max = 10, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map<string, { count: number; reset: number }>();
  return {
    blocked(key: string) {
      const h = hits.get(key);
      return !!h && h.reset > Date.now() && h.count >= max;
    },
    fail(key: string) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.reset <= now) hits.set(key, { count: 1, reset: now + windowMs });
      else h.count++;
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    },
    clear: (key: string) => void hits.delete(key),
  };
}
