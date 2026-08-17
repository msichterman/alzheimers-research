#!/usr/bin/env node
// Merge grounded-search leads into the work order — but only after a live
// service confirms them.
//
// A lead is a model's claim that a paper has a particular DOI and a particular
// open-access route. That claim is worth exactly nothing until Crossref says the
// DOI exists and the title it returns matches the paper we are looking for. This
// stage does that check and drops everything that fails it, so the only thing a
// lead can do is add a candidate identifier for pipeline/resolve.mjs to verify
// again from scratch.
//
// Open-access URLs from a lead are filtered against the same acquisition rules
// that govern everything else: no pirated mirrors, no academic social networks,
// no press releases.
//
// Usage: node pipeline/apply-leads.mjs [--dry-run]
import { join } from "node:path";
import { titleSimilarity } from "./net.mjs";
import { ROOT, log, mapLimit, readJson, writeJson } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const dryRun = process.argv.includes("--dry-run");

const targetsFile = readJson(join(CORPUS_DIR, "targets.json"));
const targets = Object.fromEntries(targetsFile.targets.map((t) => [t.id, t]));
const leads = readJson(join(CORPUS_DIR, "leads.json"))?.leads ?? {};

/** Routes that are never acceptable, whatever a model suggests. */
const FORBIDDEN = [
  /sci-hub/i,
  /libgen/i,
  /researchgate\.net/i,
  /academia\.edu/i,
  /semanticscholar\.org\/paper/i,
  /\/news\//i,
  /press-release/i,
  /scholar\.google/i,
];

const allowedUrl = (url) => typeof url === "string" && url.startsWith("http") && !FORBIDDEN.some((p) => p.test(url));

async function verifyDoi(doi) {
  const clean = String(doi ?? "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(clean)) return null;
  const { fetchJson } = await import("./net.mjs");
  const { ok, data } = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(clean)}`);
  if (!ok) return null;
  const title = Array.isArray(data.message.title) ? data.message.title[0] : data.message.title;
  return { doi: clean, title, type: data.message.type };
}

const entries = Object.values(leads).filter((l) => l.lead);
log(null, `verifying ${entries.length} lead(s) against Crossref`);

const results = await mapLimit(entries, 4, async (entry) => {
  const target = targets[entry.id];
  if (!target) return { id: entry.id, applied: false, reason: "no such target" };
  const verified = await verifyDoi(entry.lead.doi);
  if (!verified) {
    return { id: entry.id, applied: false, reason: `lead DOI ${entry.lead.doi ?? "(none)"} did not resolve at Crossref` };
  }
  const similarity = titleSimilarity(verified.title, target.title);
  if (similarity < 0.5) {
    return {
      id: entry.id,
      applied: false,
      reason: `lead DOI resolves to "${String(verified.title).slice(0, 70)}" which matches the target title at only ${similarity.toFixed(2)}`,
    };
  }
  const urls = (entry.lead.open_access_urls ?? []).filter(allowedUrl);
  const rejected = (entry.lead.open_access_urls ?? []).filter((u) => !allowedUrl(u));
  return {
    id: entry.id,
    applied: true,
    doi: verified.doi,
    crossref_title: verified.title,
    similarity: Number(similarity.toFixed(2)),
    urls,
    rejected_urls: rejected,
    pmid: /^\d+$/.test(String(entry.lead.pmid ?? "")) ? String(entry.lead.pmid) : null,
    pmcid: /^PMC\d+$/i.test(String(entry.lead.pmcid ?? "")) ? String(entry.lead.pmcid).toUpperCase() : null,
    nct: (entry.lead.nct_ids ?? []).filter((n) => /^NCT\d{8}$/i.test(String(n))).map((n) => String(n).toUpperCase()),
  };
});

let applied = 0;
const report = [];
for (const result of results) {
  if (result.error) {
    report.push({ id: "unknown", applied: false, reason: result.error.message });
    continue;
  }
  const r = result.value;
  report.push(r);
  if (!r.applied) {
    log(r.id, `lead rejected — ${r.reason}`);
    continue;
  }
  const target = targets[r.id];
  target.candidates ??= {};
  // Never overwrite an identifier the work order already supplied and that
  // resolved; only fill gaps.
  if (!target.candidates.doi) target.candidates.doi = r.doi;
  if (!target.candidates.pmid && r.pmid) target.candidates.pmid = r.pmid;
  if (!target.candidates.pmcid && r.pmcid) target.candidates.pmcid = r.pmcid;
  if (r.nct.length > 0) {
    target.candidates.nct = [...new Set([...(target.candidates.nct ?? []), ...r.nct])];
  }
  if (r.urls.length > 0 && !target.candidates.url) target.candidates.url = r.urls[0];
  target.lead_provenance = {
    source: "grounded search, verified against Crossref before use",
    doi_verified_title: r.crossref_title,
    title_similarity: r.similarity,
    rejected_urls: r.rejected_urls,
  };
  applied++;
  log(r.id, `lead applied — doi ${r.doi} (title match ${r.similarity})${r.rejected_urls.length ? `, ${r.rejected_urls.length} url(s) rejected as disallowed routes` : ""}`);
}

if (!dryRun) {
  writeJson(join(CORPUS_DIR, "targets.json"), targetsFile);
  writeJson(join(CORPUS_DIR, "leads-applied.json"), { generated_at: new Date().toISOString(), report });
}
log(null, `apply-leads complete: ${applied}/${entries.length} applied${dryRun ? " (dry run, nothing written)" : ""}`);
log(null, "next: node pipeline/resolve.mjs --force && node pipeline/acquire.mjs && node pipeline/parse.mjs");
