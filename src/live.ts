// Live channel: devices keep a WebSocket open while the app is in front. The server only says
// "something new for you" ({type: "ops"}) or "your access changed" ({type: "access"}); devices
// then pull as usual, so the socket never carries data and can drop at any time.

import type { LiveMessage } from "@lumen/shared";

export interface LiveSocket {
  send(data: string): unknown;
  data: { userId: string; deviceId: string };
}

export function createHub({ pingMs = 25_000 } = {}) {
  const byUser = new Map<string, Set<LiveSocket>>();

  const send = (ws: LiveSocket, msg: LiveMessage) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Closed mid-send; its close handler removes it.
    }
  };

  // A message every so often keeps proxies (Fly's included) from closing idle sockets.
  const timer = setInterval(() => {
    for (const sockets of byUser.values()) for (const ws of sockets) send(ws, { type: "ping" });
  }, pingMs);
  timer.unref?.();

  return {
    add(ws: LiveSocket) {
      const set = byUser.get(ws.data.userId) ?? new Set();
      set.add(ws);
      byUser.set(ws.data.userId, set);
    },
    remove(ws: LiveSocket) {
      const set = byUser.get(ws.data.userId);
      set?.delete(ws);
      if (set && !set.size) byUser.delete(ws.data.userId);
    },
    /** Tells these users' devices, except the one that caused it. */
    notify(userIds: Iterable<string>, msg: LiveMessage, exceptDevice?: string) {
      for (const id of new Set(userIds))
        for (const ws of byUser.get(id) ?? []) if (ws.data.deviceId !== exceptDevice) send(ws, msg);
    },
    connections: () => [...byUser.values()].reduce((n, s) => n + s.size, 0),
    close: () => clearInterval(timer),
  };
}

export type Hub = ReturnType<typeof createHub>;
