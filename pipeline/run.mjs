#!/usr/bin/env node
// Full pipeline: parse -> enrich -> publish. Safe to re-run; every step is
// incremental against source content hashes.
// Usage: pnpm research [id...]
import { spawnSync } from "node:child_process";
import { ROOT, log } from "./lib.mjs";

const args = process.argv.slice(2);
const steps = [
  ["parse", "pipeline/parse.mjs"],
  ["enrich", "pipeline/enrich.mjs"],
  ["publish", "pipeline/publish.mjs"],
];

for (const [name, script] of steps) {
  log(null, `=== ${name} ===`);
  const result = spawnSync("node", [script, ...args], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    log(null, `${name} failed — fix and re-run \`pnpm research\` (completed work is cached)`);
    process.exit(result.status ?? 1);
  }
}
log(null, "pipeline complete. Preview with: pnpm dev");
