#!/usr/bin/env node
// Regenerate ./progress/index.html from the pipeline's own state files. Nothing
// here is hand-maintained: every number is read from resolved.json,
// acquired.json, the raw/ and enriched/ trees, and the round log, so the page
// cannot drift from what the corpus actually contains.
//
// Built to be read on a phone: single column, no JavaScript, no external assets.
//
// Usage: node pipeline/progress.mjs
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENRICHED_DIR, RAW_DIR, ROOT, ensureDir, log, readJson, writeJson } from "./lib.mjs";
import { writeFileSync } from "node:fs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const PROGRESS_DIR = join(ROOT, "progress");

const targets = readJson(join(CORPUS_DIR, "targets.json"))?.targets ?? [];
const clusters = readJson(join(CORPUS_DIR, "targets.json"))?.clusters ?? {};
const resolved = readJson(join(CORPUS_DIR, "resolved.json"))?.records ?? {};
const acquired = readJson(join(CORPUS_DIR, "acquired.json"))?.records ?? {};
const leads = readJson(join(CORPUS_DIR, "leads.json"))?.leads ?? {};
const rounds = readJson(join(CORPUS_DIR, "rounds.json"))?.rounds ?? [];
const quarantine = readJson(join(CORPUS_DIR, "quarantine.json"))?.entries ?? [];
const leadFindings = readJson(join(CORPUS_DIR, "findings.json"))?.findings ?? [];

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const parsedIds = existsSync(RAW_DIR)
  ? readdirSync(RAW_DIR).filter((d) => existsSync(join(RAW_DIR, d, "meta.json")))
  : [];
const enrichedIds = existsSync(ENRICHED_DIR) ? readdirSync(ENRICHED_DIR) : [];

/** A target is "validated" only when it has passed every gate in validate.mjs. */
const gateReports = Object.fromEntries(
  enrichedIds
    .map((id) => [id, readJson(join(ENRICHED_DIR, id, "gates.json"))])
    .filter(([, report]) => report),
);

const state = (target) => {
  const a = acquired[target.id];
  const r = resolved[target.id];
  const gates = gateReports[target.id];
  const parsed = parsedIds.some((p) => p === target.id || p.startsWith(`${target.id}-nct`));
  if (gates?.passed) return "validated";
  if (gates && !gates.passed) return "quarantined";
  if (existsSync(join(ENRICHED_DIR, target.id, "05-evidence.json"))) return "extracted";
  if (parsed) return "parsed";
  if (a?.primary) return "acquired";
  if (r?.identity || (r?.trials ?? []).some((t) => t.resolved) || (r?.regulatory_checks ?? []).some((c) => c.ok)) return "resolved";
  return "unresolved";
};

const ORDER = ["validated", "extracted", "parsed", "acquired", "resolved", "quarantined", "unresolved"];
const rows = targets.map((t) => ({ ...t, state: state(t), acq: acquired[t.id], res: resolved[t.id] }));

const counts = ORDER.reduce((acc, s) => ({ ...acc, [s]: rows.filter((r) => r.state === s).length }), {});
const findings = Object.values(resolved).flatMap((r) => (r.findings ?? []).map((f) => ({ target: r.id, ...f })));
const manifestDiscrepancies = [
  ...leadFindings,
  ...findings.filter((f) => f.kind === "manifest-vs-source" || f.kind === "weak-title-match"),
  ...Object.values(gateReports).flatMap((g) =>
    (g.manifest_discrepancies ?? []).map((d) => ({ target: g.id, kind: "manifest-vs-source", ...d })),
  ),
];
const unresolvedIds = findings.filter((f) =>
  ["unresolved-identity", "unresolved-identifier", "unresolved-url", "no-access-route"].includes(f.kind),
);

const quarantineQueue = [
  ...Object.values(acquired)
    .filter((a) => a.quarantine)
    .map((a) => ({ id: a.id, stage: "acquisition", reason: a.quarantine.reason, detail: (a.quarantine.blocked_routes ?? []).slice(0, 3).join(" · ") })),
  ...Object.values(gateReports)
    .filter((g) => !g.passed)
    .map((g) => ({ id: g.id, stage: "validation", reason: (g.failures ?? []).map((f) => f.gate).join(", "), detail: (g.failures ?? []).map((f) => f.detail).join(" · ") })),
];
// quarantine.json is written by validate.mjs from the same gate reports, so it
// is only used to catch entries for records that no longer have a gates.json.
for (const entry of quarantine) {
  if (!quarantineQueue.some((q) => q.id === entry.id)) quarantineQueue.push(entry);
}

const completeness = Object.values(acquired).reduce((acc, a) => {
  acc[a.evidence_completeness] = (acc[a.evidence_completeness] ?? 0) + 1;
  return acc;
}, {});

const pct = (n) => (targets.length ? Math.round((n / targets.length) * 100) : 0);

const CSS = `
:root{--bg:#0e1116;--panel:#161b22;--line:#26303d;--fg:#e6edf3;--dim:#8b98a5;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--info:#58a6ff}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}
.card .n{font-size:22px;font-weight:600}.card .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;display:flex;margin:10px 0 4px}
.bar i{display:block;height:100%}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--info);word-break:break-all}
.pill{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;font-weight:500;white-space:nowrap}
.validated{background:#12341f;color:var(--ok)}.extracted{background:#132b45;color:var(--info)}
.parsed{background:#1c2733;color:#a5c8ff}.acquired{background:#2b2413;color:var(--warn)}
.resolved{background:#22262c;color:var(--dim)}.quarantined{background:#3d1518;color:var(--bad)}
.unresolved{background:#3d1518;color:var(--bad)}
.muted{color:var(--dim)}.small{font-size:12px}
details{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px}
summary{cursor:pointer;font-weight:500}
.empty{color:var(--dim);font-style:italic;padding:8px 0}
@media(max-width:520px){td:nth-child(3),th:nth-child(3){display:none}}
`;

const stateBar = ORDER.filter((s) => counts[s])
  .map((s) => {
    const color = { validated: "#3fb950", extracted: "#58a6ff", parsed: "#a5c8ff", acquired: "#d29922", resolved: "#485563", quarantined: "#f85149", unresolved: "#8b3a3a" }[s];
    return `<i style="width:${pct(counts[s])}%;background:${color}" title="${s}"></i>`;
  })
  .join("");

const clusterRows = Object.entries(clusters)
  .map(([key, label]) => {
    const inCluster = rows.filter((r) => r.cluster === key);
    const verdicts = rounds.flatMap((r) => (r.ab_verdicts ?? []).filter((v) => v.cluster === key));
    const latest = verdicts[verdicts.length - 1];
    return `<tr>
      <td>${esc(label)}<div class="muted small">${inCluster.filter((r) => r.state === "validated").length}/${inCluster.length} validated</div></td>
      <td>${latest ? `<span class="pill ${latest.winner === "corpus" ? "validated" : "quarantined"}">${esc(latest.winner)}</span>` : '<span class="muted small">not yet run</span>'}</td>
      <td class="small muted">${esc(latest?.largest_gap ?? "—")}</td>
    </tr>`;
  })
  .join("");

const recordRows = rows
  .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.rank - b.rank)
  .map((r) => {
    const identity = r.res?.identity?.doi ?? r.res?.trials?.[0]?.nct ?? r.res?.regulatory_checks?.[0]?.final_url ?? "—";
    return `<tr>
      <td><span class="pill ${r.state}">${r.state}</span></td>
      <td>${esc(r.title.slice(0, 90))}<div class="muted small">${esc(clusters[r.cluster] ?? r.cluster)}${r.acq?.evidence_completeness && r.acq.evidence_completeness !== "none" ? ` · ${esc(r.acq.evidence_completeness)}` : ""}</div></td>
      <td><code>${esc(String(identity).slice(0, 60))}</code></td>
    </tr>`;
  })
  .join("");

const roundsHtml = rounds.length
  ? rounds
      .slice()
      .reverse()
      .map(
        (round) => `<details${round === rounds[rounds.length - 1] ? " open" : ""}>
      <summary>Round ${round.round} — ${esc(round.started_at?.slice(0, 16).replace("T", " ") ?? "")} · ${esc(round.focus ?? "")}</summary>
      <table><tr><th>Cluster</th><th>Winner</th><th>Largest gap in the loser</th></tr>
      ${(round.ab_verdicts ?? [])
        .map(
          (v) => `<tr><td>${esc(clusters[v.cluster] ?? v.cluster)}</td><td><span class="pill ${v.winner === "corpus" ? "validated" : "quarantined"}">${esc(v.winner)}</span></td><td class="small">${esc(v.largest_gap)}</td></tr>`,
        )
        .join("")}
      </table>
      ${round.next_builder_tasks?.length ? `<div class="small muted" style="margin-top:8px">Next builder tasks: ${round.next_builder_tasks.map(esc).join(" · ")}</div>` : ""}
    </details>`,
      )
      .join("")
  : '<div class="empty">No blind A/B round has completed yet.</div>';

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>Alzheimer's corpus expansion — live progress</title>
<style>${CSS}</style></head><body>

<h1>Alzheimer's corpus expansion</h1>
<div class="sub">Generated ${new Date().toISOString().replace("T", " ").slice(0, 19)}Z · auto-refreshes every 2 min · ${targets.length} targets in the work order</div>

<div class="bar">${stateBar}</div>
<div class="grid">
  <div class="card"><div class="n" style="color:var(--ok)">${counts.validated}</div><div class="l">validated</div></div>
  <div class="card"><div class="n" style="color:var(--info)">${counts.extracted}</div><div class="l">extracted</div></div>
  <div class="card"><div class="n">${counts.parsed}</div><div class="l">parsed</div></div>
  <div class="card"><div class="n" style="color:var(--warn)">${counts.acquired}</div><div class="l">acquired</div></div>
  <div class="card"><div class="n" style="color:var(--bad)">${quarantineQueue.length}</div><div class="l">quarantined</div></div>
  <div class="card"><div class="n" style="color:var(--bad)">${unresolvedIds.length}</div><div class="l">unresolved ids</div></div>
</div>

<h2>Evidence completeness</h2>
<table><tr><th>Level</th><th>Records</th><th>Meaning</th></tr>
${Object.entries({
  "full-text-oa": "version of record or full text via PMC / publisher open access",
  "accepted-manuscript": "legal institutional or repository accepted manuscript",
  "regulator-or-registry": "FDA/EMA document or registry protocol as the primary record",
  "registry-only": "registry record is the primary record by design",
  "registry-substitute": "version of record unreachable; registry stands in, DOI preserved",
  "landing-page-only": "identity only, no usable text layer",
  none: "no primary document acquired",
})
  .filter(([level]) => completeness[level])
  .map(([level, meaning]) => `<tr><td><code>${esc(level)}</code></td><td>${completeness[level]}</td><td class="small muted">${esc(meaning)}</td></tr>`)
  .join("")}
</table>

<h2>Blind A/B verdicts by cluster</h2>
<table><tr><th>Cluster</th><th>Latest winner</th><th>Largest gap named</th></tr>${clusterRows}</table>

<h2>Rounds</h2>
${roundsHtml}

<h2>Quarantine queue <span class="muted small">(${quarantineQueue.length})</span></h2>
${
  quarantineQueue.length
    ? `<table><tr><th>Record</th><th>Reason</th><th>Detail</th></tr>${quarantineQueue
        .map((q) => `<tr><td><code>${esc(q.id)}</code><div class="muted small">${esc(q.stage)}</div></td><td class="small">${esc(q.reason)}</td><td class="small muted">${esc(String(q.detail ?? "").slice(0, 180))}</td></tr>`)
        .join("")}</table>`
    : '<div class="empty">Nothing in quarantine.</div>'
}

<h2>Unresolved identifiers <span class="muted small">(${unresolvedIds.length})</span></h2>
${
  unresolvedIds.length
    ? `<table><tr><th>Target</th><th>Kind</th><th>Detail</th></tr>${unresolvedIds
        .map((f) => `<tr><td><code>${esc(f.target)}</code></td><td class="small">${esc(f.kind)}</td><td class="small muted">${esc(String(f.detail).slice(0, 200))}</td></tr>`)
        .join("")}</table>`
    : '<div class="empty">Every identifier in the work order resolved live.</div>'
}

<h2>Manifest-versus-source discrepancies <span class="muted small">(${manifestDiscrepancies.length})</span></h2>
<div class="sub">The work order is not evidence. Where it disagrees with the retrieved primary document, the document wins and the disagreement is recorded here.</div>
${
  manifestDiscrepancies.length
    ? `<table><tr><th>Target</th><th>Field</th><th>What the source actually says</th></tr>${manifestDiscrepancies
        .map(
          (d) =>
            `<tr><td><code>${esc(d.target)}</code></td><td class="small">${esc(d.field ?? d.identifier ?? d.kind)}</td><td class="small muted">${esc(String(d.detail ?? d.source_says ?? "").slice(0, 260))}</td></tr>`,
        )
        .join("")}</table>`
    : '<div class="empty">None recorded yet.</div>'
}

<h2>Grounded-search leads <span class="muted small">(${Object.keys(leads).length}, unverified)</span></h2>
<div class="sub">Leads from Gemini with Google Search grounding, used only to find candidate identifiers. Every one is re-verified against Crossref, Europe PMC, NCBI and ClinicalTrials.gov before it can enter a record.</div>
${
  Object.keys(leads).length
    ? `<table><tr><th>Target</th><th>Lead DOI</th><th>Confidence</th></tr>${Object.values(leads)
        .map((l) => `<tr><td><code>${esc(l.id)}</code></td><td><code>${esc(l.lead?.doi ?? "—")}</code></td><td class="small">${esc(l.lead?.confidence ?? "unparsed")}</td></tr>`)
        .join("")}</table>`
    : '<div class="empty">No leads generated yet.</div>'
}

<h2>All records</h2>
<table><tr><th>State</th><th>Record</th><th>Identity</th></tr>${recordRows}</table>

<div class="sub" style="margin-top:24px">Sources of truth: <code>pipeline/corpus/resolved.json</code>, <code>pipeline/corpus/acquired.json</code>, <code>raw/</code>, <code>enriched/*/gates.json</code>, <code>pipeline/corpus/rounds.json</code>.</div>
</body></html>`;

ensureDir(PROGRESS_DIR);
writeFileSync(join(PROGRESS_DIR, "index.html"), html);
writeJson(join(PROGRESS_DIR, "state.json"), {
  generated_at: new Date().toISOString(),
  counts,
  completeness,
  quarantine: quarantineQueue.length,
  unresolved_identifiers: unresolvedIds.length,
  manifest_discrepancies: manifestDiscrepancies.length,
  rounds: rounds.length,
});
log(null, `progress/index.html regenerated — ${counts.validated} validated, ${counts.extracted} extracted, ${quarantineQueue.length} quarantined`);
