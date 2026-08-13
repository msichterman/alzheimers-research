#!/usr/bin/env node
// Acquire the primary document for every resolved target, in the order the
// hard rules demand:
//
//   1. regulator or registry   (FDA/EMA documents, ClinicalTrials.gov v2 JSON)
//   2. PubMed Central or publisher open access
//   3. a legal institutional accepted manuscript
//   4. the publisher landing page
//
// Never a pirated copy, and never a press release or news summary standing in
// for a primary record. When the version of record is genuinely unreachable the
// canonical DOI is preserved, the registry and regulatory records are ingested
// instead, and the record's evidence completeness is marked down rather than
// quietly filled in.
//
// Files land in sources/ (the existing ingest path). Every acquisition stores a
// SHA-256, byte count, content type, final URL after redirects, and the tier it
// came from, in pipeline/corpus/acquired.json.
//
// Usage: node pipeline/acquire.mjs [targetId...] [--force] [--cluster <name>]
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { politeFetch } from "./net.mjs";
import { ROOT, SOURCES_DIR, ensureDir, log, mapLimit, readJson, sha256, writeJson } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const OUT = join(CORPUS_DIR, "acquired.json");

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const clusterIndex = argv.indexOf("--cluster");
const onlyCluster = clusterIndex >= 0 ? argv[clusterIndex + 1] : null;
const onlyIds = argv.filter((a, i) => !a.startsWith("--") && (clusterIndex === -1 || i !== clusterIndex + 1));

const { records } = readJson(join(CORPUS_DIR, "resolved.json"));
const previous = force ? {} : (readJson(OUT)?.records ?? {});
const nowIso = () => new Date().toISOString();

const EXTENSIONS = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/xml": ".xml",
  "application/xml": ".xml",
  "text/html": ".html",
  "text/plain": ".txt",
};

/**
 * A file is only usable as evidence if it is what it claims to be and carries a
 * real text layer. An HTML challenge page saved as ".pdf", a 300-byte paywall
 * stub, or an image-only scan all fail here rather than downstream.
 */
function integrity(buffer, contentType, kind) {
  const head = buffer.subarray(0, 4096).toString("latin1");
  const isPdf = head.startsWith("%PDF");
  const looksHtml = /<html|<!doctype html/i.test(head);
  // Bot-challenge and consent interstitials are small HTML pages that answer 200.
  const challenge = /Content-Security-Policy|captcha|Just a moment|Checking your browser|Enable JavaScript and cookies/i.test(head);
  if (buffer.length < 1024) return { ok: false, reason: `file is ${buffer.length} bytes — too small to be a primary document` };
  if (kind.includes("pdf") && !isPdf) {
    return { ok: false, reason: looksHtml ? "PDF route returned an HTML page (paywall, consent wall or challenge)" : "PDF route returned a non-PDF payload" };
  }
  if (contentType?.includes("pdf") && !isPdf) return { ok: false, reason: "content-type says PDF but the bytes are not a PDF" };
  if (looksHtml && challenge && buffer.length < 60000) {
    return { ok: false, reason: "route returned a bot-challenge or consent interstitial, not the document" };
  }
  if (looksHtml && buffer.length < 8000 && kind !== "regulator") {
    return { ok: false, reason: `route returned a ${buffer.length}-byte HTML stub rather than a document` };
  }
  if (kind === "registry" || kind === "pmc-xml" || kind === "pmc-efetch") {
    try {
      if (kind === "registry") JSON.parse(buffer.toString("utf8"));
      else if (!buffer.toString("utf8").includes("<article")) throw new Error("no JATS article element");
    } catch (error) {
      return { ok: false, reason: `structured route did not return parseable content: ${error.message}` };
    }
  }
  return { ok: true, is_pdf: isPdf, looks_html: looksHtml };
}

async function download(url, kind) {
  const response = await politeFetch(url, {
    headers: {
      accept: kind === "registry" ? "application/json" : "application/pdf,application/xml,text/html;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    return { ok: false, http_status: response.status, url, final_url: response.url, reason: `HTTP ${response.status}` };
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  const buffer = Buffer.from(await response.arrayBuffer());
  const check = integrity(buffer, contentType, kind);
  return {
    ok: check.ok,
    reason: check.reason ?? null,
    http_status: response.status,
    url,
    final_url: response.url,
    content_type: contentType,
    buffer,
  };
}

function saveTo(name, kind, contentType, buffer) {
  const extension =
    EXTENSIONS[contentType] ??
    (kind.includes("pdf") ? ".pdf" : kind === "registry" ? ".json" : kind.includes("xml") ? ".xml" : ".html");
  const path = join(SOURCES_DIR, `${name}${extension}`);
  ensureDir(SOURCES_DIR);
  writeFileSync(path, buffer);
  return { path: `sources/${name}${extension}`, extension };
}

async function acquireTarget(record) {
  const result = {
    id: record.id,
    cluster: record.cluster,
    type: record.type,
    acquired_at: nowIso(),
    canonical_doi: record.identity?.doi ?? null,
    primary: null,
    companions: [],
    attempts: [],
    evidence_completeness: "none",
    quarantine: null,
  };

  // Registry records are companions on every target that has an NCT id, and the
  // primary document for a registry-type target. They resolve independently of
  // any paper, so they are always fetched.
  for (const trial of record.trials.filter((t) => t.resolved)) {
    const attempt = await download(`https://clinicaltrials.gov/api/v2/studies/${trial.nct}`, "registry");
    result.attempts.push({ tier: 1, kind: "registry", url: attempt.url, ok: attempt.ok, http_status: attempt.http_status, reason: attempt.reason });
    if (!attempt.ok) continue;
    const saved = saveTo(`${record.id}-${trial.nct.toLowerCase()}`, "registry", attempt.content_type, attempt.buffer);
    const companion = {
      role: "registry",
      nct: trial.nct,
      tier: 1,
      ...saved,
      url: attempt.url,
      final_url: attempt.final_url,
      content_type: attempt.content_type,
      sha256: sha256(attempt.buffer),
      bytes: attempt.buffer.length,
      observed_at: nowIso(),
      source: "ClinicalTrials.gov API v2",
    };
    result.companions.push(companion);
  }

  // Walk the access plan in tier order and stop at the first route that yields
  // a real document.
  const plan = [...record.access_plan].sort((a, b) => a.tier - b.tier);
  for (const step of plan) {
    if (result.primary) break;
    // A registry companion already covers this route for registry-type targets.
    if (step.kind === "registry" && result.companions.some((c) => c.url === step.url)) {
      const companion = result.companions.find((c) => c.url === step.url);
      if (record.type === "registry") {
        result.primary = { ...companion, role: "primary", kind: "registry", note: step.note };
        result.evidence_completeness = "registry-only";
      }
      continue;
    }
    // A landing page — publisher or repository — is a citation target, not a
    // primary document. Unpaywall's `url_for_landing_page` routinely points at an
    // abstract page or a repository splash screen, and accepting one would create
    // a record whose evidence is a menu. They stay in the plan as canonical
    // identity and are recorded as attempted, but never ingested as evidence.
    if (step.kind.endsWith("-landing")) {
      result.attempts.push({
        tier: step.tier,
        kind: step.kind,
        url: step.url,
        ok: false,
        reason: "landing page is a citation target, not a primary document — not ingested as evidence",
      });
      continue;
    }
    const attempt = await download(step.url, step.kind);
    result.attempts.push({ tier: step.tier, kind: step.kind, url: step.url, ok: attempt.ok, http_status: attempt.http_status, reason: attempt.reason });
    if (!attempt.ok) continue;
    const saved = saveTo(record.id, step.kind, attempt.content_type, attempt.buffer);
    result.primary = {
      role: "primary",
      tier: step.tier,
      kind: step.kind,
      note: step.note,
      ...saved,
      url: attempt.url,
      final_url: attempt.final_url,
      content_type: attempt.content_type,
      sha256: sha256(attempt.buffer),
      bytes: attempt.buffer.length,
    };
    result.evidence_completeness =
      step.tier === 1 ? "regulator-or-registry" : step.tier === 2 ? "full-text-oa" : step.tier === 3 ? "accepted-manuscript" : "landing-page-only";
  }

  if (!result.primary) {
    if (result.companions.length > 0) {
      // Version of record unreachable: preserve the canonical DOI, keep the
      // registry (and regulatory) records, and mark the record down.
      result.primary = { ...result.companions[0], role: "primary-substitute", kind: "registry" };
      result.evidence_completeness = "registry-substitute";
      result.quarantine = {
        reason: "version of record unreachable; registry record ingested in its place",
        canonical_doi: result.canonical_doi,
        blocked_routes: result.attempts.filter((a) => !a.ok).map((a) => `${a.kind} ${a.http_status ?? ""} ${a.reason ?? ""}`.trim()),
      };
    } else {
      result.quarantine = {
        reason: "no acquisition route returned a usable primary document",
        canonical_doi: result.canonical_doi,
        blocked_routes: result.attempts.map((a) => `${a.kind} ${a.http_status ?? ""} ${a.reason ?? ""}`.trim()),
      };
    }
  }
  return result;
}

const queue = Object.values(records).filter(
  (r) =>
    (onlyIds.length === 0 || onlyIds.includes(r.id)) &&
    (!onlyCluster || r.cluster === onlyCluster) &&
    (force || !previous[r.id]?.primary),
);
log(null, `acquiring ${queue.length} target(s)`);

const acquired = { ...previous };
const results = await mapLimit(queue, 4, async (record) => {
  const result = await acquireTarget(record);
  log(
    record.id,
    result.primary
      ? `${result.evidence_completeness} via tier ${result.primary.tier} ${result.primary.kind} -> ${result.primary.path} (${result.primary.bytes} bytes)`
      : `QUARANTINE: ${result.quarantine.reason}`,
  );
  return result;
});

let failed = 0;
results.forEach((result, i) => {
  if (result.error) {
    failed++;
    log(queue[i].id, `FAILED: ${result.error.message}`);
    acquired[queue[i].id] = {
      id: queue[i].id,
      cluster: queue[i].cluster,
      acquired_at: nowIso(),
      primary: null,
      companions: [],
      attempts: [],
      evidence_completeness: "none",
      quarantine: { reason: `acquisition error: ${result.error.message}` },
    };
    return;
  }
  acquired[result.value.id] = result.value;
});

const summary = Object.values(acquired).reduce((acc, r) => {
  acc[r.evidence_completeness] = (acc[r.evidence_completeness] ?? 0) + 1;
  return acc;
}, {});
writeJson(OUT, { generated_at: nowIso(), count: Object.keys(acquired).length, records: acquired });
log(null, `acquire complete: ${Object.keys(acquired).length} records, ${failed} errored`);
for (const [level, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
  log(null, `  ${level}: ${count}`);
}
