#!/usr/bin/env node
// Parse everything in sources/ to clean Markdown in raw/<id>/ via @firecrawl/anydoc.
// Idempotent: skips sources whose content hash already matches raw/<id>/meta.json.
// Usage: pnpm parse [id...] [--force]
import { toMarkdown } from "@firecrawl/anydoc";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  RAW_DIR,
  ROOT,
  SOURCES_DIR,
  ensureDir,
  log,
  readJson,
  sha256,
  slugify,
  writeJson,
} from "./lib.mjs";

const SUPPORTED = new Set([
  ".pdf", ".doc", ".docx", ".docm", ".ppt", ".pptx", ".pptm", ".ppsx",
  ".xls", ".xlsx", ".xlsm", ".odt", ".ods", ".odp", ".rtf", ".epub", ".csv",
]);

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const onlyIds = argv.filter((a) => a !== "--force");

const anydocVersion = readJson(
  join(ROOT, "node_modules", "@firecrawl", "anydoc", "package.json"),
)?.version;

let parsed = 0;
let skipped = 0;
const failures = [];

const sources = readdirSync(SOURCES_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && SUPPORTED.has(extname(e.name).toLowerCase()))
  .map((e) => join(SOURCES_DIR, e.name));

if (sources.length === 0) {
  log(null, "sources/ is empty — add articles with: pnpm ingest <path-or-url>");
  process.exit(0);
}

for (const source of sources) {
  const id = slugify(basename(source));
  if (onlyIds.length > 0 && !onlyIds.includes(id)) continue;

  const bytes = readFileSync(source);
  const hash = sha256(bytes);
  const metaPath = join(RAW_DIR, id, "meta.json");
  const existing = readJson(metaPath);
  if (!force && existing?.sha256 === hash) {
    skipped++;
    log(id, "unchanged, skipping (use --force to reparse)");
    continue;
  }

  try {
    const markdown = (await toMarkdown(source))
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    ensureDir(join(RAW_DIR, id));
    writeFileSync(join(RAW_DIR, id, "document.md"), `${markdown}\n`);
    writeJson(metaPath, {
      id,
      source: relative(ROOT, source),
      sha256: hash,
      bytes: bytes.length,
      chars: markdown.length,
      parser: `@firecrawl/anydoc@${anydocVersion ?? "unknown"}`,
      parsed_at: new Date().toISOString(),
    });
    parsed++;
    log(id, `parsed ${basename(source)} -> raw/${id}/document.md (${markdown.length} chars)`);
  } catch (error) {
    failures.push({ source: relative(ROOT, source), code: error.code, message: error.message });
    log(id, `FAILED (${error.code ?? "error"}): ${error.message}`);
  }
}

log(null, `parse complete: ${parsed} parsed, ${skipped} unchanged, ${failures.length} failed`);
if (failures.length > 0) {
  log(null, "failed files (encrypted/image-only PDFs need OCR — see PIPELINE.md):");
  for (const f of failures) log(null, `  ${f.source}: ${f.code}`);
  if (parsed === 0 && skipped === 0) process.exit(1);
}
