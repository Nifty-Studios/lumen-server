// Stages a minimal build context (server + ../shared, no node_modules or tests) and runs
// `fly deploy` from it. Extra args are passed through, e.g. `bun run deploy --remote-only`.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const server = resolve(import.meta.dir, "..");
const shared = resolve(server, "../shared");
const stage = join(server, ".fly-build");

const skipTests = (src: string) => !src.endsWith(".test.ts");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(server, "Dockerfile"), join(stage, "Dockerfile"));
cpSync(join(server, "fly.toml"), join(stage, "fly.toml"));
for (const [name, root] of [["server", server], ["shared", shared]] as const) {
  cpSync(join(root, "package.json"), join(stage, name, "package.json"));
  cpSync(join(root, "src"), join(stage, name, "src"), { recursive: true, filter: skipTests });
}

const proc = Bun.spawnSync(["fly", "deploy", ...process.argv.slice(2)], { cwd: stage, stdio: ["inherit", "inherit", "inherit"] });
process.exit(proc.exitCode ?? 1);
