#!/usr/bin/env node
// Runs any command with the DuckDB static-link environment staged.
//
//   node scripts/with-duckdb.mjs <command> [args...]
//
// Ensures src-tauri/libs/<triple> holds the prebuilt archives (via
// fetch-duckdb.mjs; no-op on Windows where `--features source-bundled`
// compiles from source), then exports DUCKDB_LIB_DIR + DUCKDB_STATIC=1
// (unless already set in the environment).
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , ...cmd] = process.argv;
if (cmd.length === 0) {
  console.error("usage: node scripts/with-duckdb.mjs <command> [args...]");
  process.exit(2);
}

function hostTriple() {
  if (process.env.DUCKDB_TRIPLE) return process.env.DUCKDB_TRIPLE;
  try {
    const m = execSync("rustc -vV", { encoding: "utf8" }).match(/^host:\s*(\S+)/m);
    if (m) return m[1];
  } catch { /* fall through */ }
  return null;
}

// Stage the archives first (fast no-op when already staged).
const fetch = spawnSync(process.execPath, [join(root, "scripts", "fetch-duckdb.mjs")], { stdio: "inherit" });
if (fetch.status !== 0) process.exit(fetch.status ?? 1);

const env = { ...process.env };
const triple = hostTriple();
const libsDir = triple ? join(root, "src-tauri", "libs", triple) : null;
if (!env.DUCKDB_LIB_DIR && libsDir && existsSync(join(libsDir, "libduckdb_static.a"))) {
  env.DUCKDB_LIB_DIR = libsDir;
  env.DUCKDB_STATIC ??= "1";
}

let [bin, ...args] = cmd;
// Prefer the repo-local Tauri CLI when present so this also works outside
// `npm run` (where node_modules/.bin is not on PATH).
if (bin === "tauri") {
  const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
  if (existsSync(local)) bin = local;
}

const child = spawn(bin, args, { stdio: "inherit", shell: process.platform === "win32", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
