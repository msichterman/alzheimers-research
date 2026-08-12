#!/usr/bin/env node
// Verify every internal link in docs/**/*.mdx resolves to a page, and every
// redirect in blume.config.ts points at a real route. Catches the link rot
// that moving/renaming pages leaves behind. Usage: pnpm check:links
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCS_DIR, ROOT, log } from "./lib.mjs";

const pages = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".mdx")) pages.push(full);
  }
};
walk(DOCS_DIR);

/**
 * Agent-facing files Blume emits at build time. They are real URLs on the
 * built site but never content pages, so they'd read as broken here — and
 * they 404 on the dev server, which only serves routes.
 */
const GENERATED_ARTIFACTS = [
  "/llms.txt",
  "/llms-full.txt",
  "/agent-readability.json",
  "/sitemap.xml",
  "/robots.txt",
];

const routeExists = (route) => {
  const clean = route.replace(/[#?].*$/, "").replace(/\/$/, "") || "/index";
  if (GENERATED_ARTIFACTS.includes(clean) || clean.startsWith("/.well-known/")) {
    return true;
  }
  const base = join(DOCS_DIR, clean === "/index" ? "index" : clean.slice(1));
  return existsSync(`${base}.mdx`) || existsSync(join(base, "index.mdx"));
};

const broken = [];
for (const page of pages) {
  const lines = readFileSync(page, "utf8").split("\n");
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    for (const match of line.matchAll(/\]\((\/[^)\s]*)\)/g)) {
      if (!routeExists(match[1])) {
        broken.push(`${relative(ROOT, page)}:${i + 1}  ${match[1]}`);
      }
    }
  });
}

// Redirect targets must exist; redirect sources must NOT (else they shadow a page).
const config = readFileSync(join(ROOT, "blume.config.ts"), "utf8");
for (const match of config.matchAll(/from:\s*"([^"]+)",?\s*\n\s*to:\s*"([^"]+)"/g)) {
  if (!routeExists(match[2])) broken.push(`blume.config.ts  redirect target missing: ${match[2]}`);
  if (routeExists(match[1])) broken.push(`blume.config.ts  redirect source shadows a real page: ${match[1]}`);
}

if (broken.length > 0) {
  log(null, `${broken.length} broken internal link(s):`);
  for (const b of broken) console.log(`  ${b}`);
  process.exit(1);
}
log(null, `all internal links resolve (${pages.length} pages checked)`);
