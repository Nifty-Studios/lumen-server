# Lumen sync server

A small relay that lets Lumen devices sync. Devices push their ops; the server stores them in arrival order and serves them back to the other devices. It never merges records: each device merges with `applyOp` from [`lumen-shared`](https://github.com/Nifty-Studios/lumen-shared), which must be checked out at `../shared`.

Built with Bun, Hono and SQLite. Single user, authenticated with one bearer token.

```sh
pnpm install
LUMEN_TOKEN=$(openssl rand -hex 32) bun run dev
bun test
pnpm typecheck
```

| Env | Default | |
|---|---|---|
| `LUMEN_TOKEN` | (required) | Bearer token, at least 32 characters |
| `LUMEN_DB` | `./data/lumen-server.db` | SQLite file |
| `PORT` | `8787` | |

## API

- `GET /health`
- `POST /sync/push` `{ device_id, ops[] }` → `{ accepted }`. Duplicate op ids are ignored.
- `GET /sync/pull?since=<cursor>&limit=<n>&device_id=<id>` → `{ ops[], cursor, has_more }`. Ops from `device_id` itself are skipped, but the cursor still moves past them.

## Docker

Build from the Lumen root so `shared/` is in the build context:

```sh
docker build -f server/Dockerfile -t lumen-server .
docker run -d -p 8787:8787 -v lumen-data:/data -e LUMEN_TOKEN=... lumen-server
```
