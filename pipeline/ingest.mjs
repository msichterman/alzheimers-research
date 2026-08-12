#!/usr/bin/env node
// Pull an article into sources/: `pnpm ingest <path-or-url> [more...] [--name <slug>]`
// --name applies when ingesting a single item.
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { SOURCES_DIR, ensureDir, log, slugify } from "./lib.mjs";

const argv = process.argv.slice(2);
const nameIndex = argv.indexOf("--name");
const customName = nameIndex >= 0 ? argv[nameIndex + 1] : null;
const inputs = argv.filter(
  (a, i) => a !== "--name" && (nameIndex === -1 || i !== nameIndex + 1),
);

if (inputs.length === 0) {
  console.error("Usage: pnpm ingest <path-or-url> [more...] [--name <slug>]");
  process.exit(1);
}
if (customName && inputs.length > 1) {
  console.error("--name only works with a single input.");
  process.exit(1);
}

ensureDir(SOURCES_DIR);

function targetPath(rawName, extension) {
  let base = slugify(customName || rawName) || "document";
  let candidate = join(SOURCES_DIR, `${base}${extension}`);
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = join(SOURCES_DIR, `${base}-${counter++}${extension}`);
  }
  return candidate;
}

for (const input of inputs) {
  if (/^https?:\/\//.test(input)) {
    const response = await fetch(input, {
      headers: { "user-agent": "alzheimers-research-pipeline/1.0" },
      redirect: "follow",
    });
    if (!response.ok) {
      console.error(`FAILED ${input}: HTTP ${response.status}`);
      process.exitCode = 1;
      continue;
    }
    const disposition = response.headers.get("content-disposition") || "";
    const dispositionName = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1];
    const urlName = decodeURIComponent(
      dispositionName || basename(new URL(input).pathname) || "download",
    );
    const type = response.headers.get("content-type") || "";
    const extension =
      extname(urlName).toLowerCase() || (type.includes("pdf") ? ".pdf" : ".bin");
    const target = targetPath(urlName, extension);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    log(null, `downloaded ${input} -> ${target}`);
  } else {
    if (!existsSync(input)) {
      console.error(`FAILED ${input}: file not found`);
      process.exitCode = 1;
      continue;
    }
    const target = targetPath(basename(input), extname(input).toLowerCase());
    copyFileSync(input, target);
    log(null, `copied ${input} -> ${target}`);
  }
}

log(null, "next: pnpm research   (parse -> enrich -> publish)");
