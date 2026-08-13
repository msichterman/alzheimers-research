#!/usr/bin/env node
// Render validated evidence records into the Blume site.
//
// Only records whose gates.json says passed:true are rendered. A record that
// failed a gate stays in quarantine and does not get a page — that is what
// "nothing publishes until it passes the validation gates" has to mean in
// practice, otherwise the gates are decoration.
//
// The renderer owns the structure and the agents supply the content, matching
// the existing publish.mjs contract. Every page carries the mandatory Critical
// review block, and every page carries its provenance: which document was
// retrieved, from which tier, with which checksum, and what the independent
// critic and the adjudicator did to it.
//
// Usage: node pipeline/publish-evidence.mjs [id...] [--include-quarantined]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_DIR, ENRICHED_DIR, ROOT, ensureDir, log, mdxSafe, readJson, slugify, yamlString } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const PAPERS_DIR = join(DOCS_DIR, "research", "papers");
const TRIALS_DIR = join(DOCS_DIR, "trials");

const argv = process.argv.slice(2);
const includeQuarantined = argv.includes("--include-quarantined");
const onlyIds = argv.filter((a) => !a.startsWith("--"));

const targets = Object.fromEntries((readJson(join(CORPUS_DIR, "targets.json"))?.targets ?? []).map((t) => [t.id, t]));
const resolved = readJson(join(CORPUS_DIR, "resolved.json"))?.records ?? {};
const acquired = readJson(join(CORPUS_DIR, "acquired.json"))?.records ?? {};

const val = (node) => (node && typeof node === "object" && "value" in node ? node.value : node);

/**
 * Extracted values are data, not authored Markdown, and they routinely contain
 * characters MDX reads as syntax: "p<0.001" and "<1%" both look like the start
 * of a JSX tag and fail the build. Everything rendered from a record goes
 * through here.
 */
const safe = (v) => mdxSafe(v ?? "—").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cell = (v) => safe(v).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const has = (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/** Outcome rows, primary first, with prespecification and tier always visible. */
function outcomesTable(record) {
  const order = { primary: 0, secondary: 1, exploratory: 2, subgroup: 3, post_hoc: 4 };
  const rows = [...(record.outcomes ?? [])].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9));
  if (rows.length === 0) return null;
  return [
    "| Outcome | Tier | Prespecified | Met | Effect | Interval | p | Multiplicity |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (o) =>
        `| ${cell(o.name)} | ${cell(o.tier)} | ${cell(o.prespecified)} | ${cell(o.met)} | ${cell(o.effect_estimate)} | ${cell(o.confidence_interval)} | ${cell(o.p_value)} | ${cell(o.multiplicity_controlled)} |`,
    ),
  ].join("\n");
}

function harmsTable(record) {
  const harms = record.safety?.harms ?? [];
  if (harms.length === 0) return null;
  return [
    "| Harm | Arm | APOE stratum | n | Denominator | % |",
    "| --- | --- | --- | --- | --- | --- |",
    ...harms.map(
      (h) => `| ${cell(h.name)} | ${cell(h.arm)} | ${cell(h.apoe_stratum)} | ${cell(h.count)} | ${cell(h.denominator)} | ${cell(h.percentage)} |`,
    ),
  ].join("\n");
}

const bullets = (items = []) => items.filter(has).map((i) => `- ${safe(typeof i === "string" ? i : JSON.stringify(i))}`).join("\n");

/**
 * The Critical review block. This is a hard gate upstream, so it is never
 * conditional here: if a record reached publication it has these parts, and the
 * page states plainly what the primary endpoint did, how multiplicity was
 * handled, and what could not be found in the retrieved text.
 */
function criticalReview(id, record, final, fidelity, gates) {
  const parts = [`\n## Critical review\n`];
  const status = record.primary_endpoint_status ?? {};
  parts.push(
    `**Primary endpoint: ${safe(status.status ?? "not recorded")}.** ${safe(status.explanation ?? "")}\n`,
  );
  if (status.quote) parts.push(`> ${safe(status.quote)}\n`);
  parts.push(`**Multiplicity handling:** ${safe(record.multiplicity?.approach ?? "not stated in the retrieved document")}\n`);

  const postHoc = (record.outcomes ?? []).filter((o) => ["post_hoc", "subgroup"].includes(o.tier));
  if (postHoc.length > 0) {
    parts.push(
      `\n### Post-hoc and subgroup results\n\n*Reported separately from prespecified outcomes and never described in outcome language.*\n\n${bullets(postHoc.map((o) => `${o.name} (${o.tier}, prespecified: ${o.prespecified})`))}\n`,
    );
  }
  if ((record.risk_of_bias ?? []).length > 0) {
    parts.push(`\n### Risk of bias\n\n${bullets(record.risk_of_bias.map((r) => `**${r.domain}** — ${r.judgement}`))}\n`);
  }
  if ((record.limitations ?? []).length > 0) parts.push(`\n### Limitations stated by the document\n\n${bullets(record.limitations)}\n`);
  if ((record.funding ?? []).length > 0) parts.push(`\n### Funding\n\n${bullets(record.funding)}\n`);
  if ((record.conflicts ?? []).length > 0) parts.push(`\n### Declared conflicts\n\n${bullets(record.conflicts)}\n`);

  if ((record.disagreements ?? []).length > 0) {
    parts.push(
      `\n### Where authoritative sources disagree\n\n*Stored as structured evidence with each position attributed to its source, not resolved into a single verdict.*\n\n${bullets(
        record.disagreements.map((d) => `**${d.question}** — ${d.position} *(${d.attributed_to})*`),
      )}\n`,
    );
  }

  // The verification record: what an independent critic and a blind adjudicator
  // actually did to this page's numbers.
  const verification = [
    fidelity
      ? `An independent re-extraction by \`${fidelity.critic_model}\`, working from the same retrieved file and nothing else, compared ${fidelity.fields_compared} fields. ${fidelity.conflicts} conflicted and ${fidelity.coverage_gaps} were found by only one extraction.`
      : null,
    final?.conflicts_ruled
      ? `${final.conflicts_ruled} conflict(s) were ruled on by a blind adjudicator reading the document, with the two readings labelled A and B and the pipeline that produced each withheld.`
      : null,
    final?.conflicts_needing_manual_apply
      ? `${final.conflicts_needing_manual_apply} ruling(s) could not be applied mechanically and are flagged for a hand edit in \`enriched/${id}/09-record.json\`.`
      : null,
    fidelity?.builder_values_not_found_in_document?.length === 0
      ? "Every value on this page was located verbatim in the retrieved document."
      : `${fidelity?.builder_values_not_found_in_document?.length ?? "?"} value(s) could not be located in the retrieved text.`,
    (record.unlocatable_fields ?? []).length > 0
      ? `${record.unlocatable_fields.length} field(s) are null because the retrieved document does not state them: ${record.unlocatable_fields.slice(0, 12).map((f) => `\`${f}\``).join(", ")}${record.unlocatable_fields.length > 12 ? ", …" : ""}`
      : null,
    (gates?.warnings ?? []).length > 0 ? `Validation warnings: ${gates.warnings.map((w) => w.detail).join("; ")}` : null,
  ].filter(Boolean);
  parts.push(`\n### Verification\n\n${bullets(verification)}\n`);
  return parts.join("");
}

function provenanceBlock(id, record) {
  const acq = acquired[id];
  const res = resolved[id];
  const primary = acq?.primary;
  const rows = [
    ["Retrieved document", primary ? `\`${primary.path}\`` : "—"],
    ["Acquisition tier", primary ? `${primary.tier} (${primary.kind})` : "—"],
    ["Evidence completeness", acq?.evidence_completeness ?? "—"],
    ["Source URL", primary?.url ? `[${primary.url.slice(0, 80)}](${primary.url})` : "—"],
    ["SHA-256", primary?.sha256 ? `\`${primary.sha256}\`` : "—"],
    ["Bytes", primary?.bytes ?? "—"],
    ["Retrieved at", acq?.acquired_at ?? "—"],
    ["DOI", res?.identity?.doi ? `[${res.identity.doi}](https://doi.org/${res.identity.doi})` : "—"],
    ["PMID", res?.identity?.pmid ? `[${res.identity.pmid}](https://pubmed.ncbi.nlm.nih.gov/${res.identity.pmid}/)` : "—"],
    ["PMCID", res?.identity?.pmcid ? `[${res.identity.pmcid}](https://europepmc.org/article/PMC/${res.identity.pmcid})` : "—"],
    ["Open access", res?.unpaywall?.oa_status ?? res?.identity?.license ?? "—"],
  ];
  const trials = (res?.trials ?? []).filter((t) => t.resolved);
  const links = [
    ...trials.map((t) => `[${t.nct}](https://clinicaltrials.gov/study/${t.nct}) — registry record, status observed ${t.trial_status_observation?.observed_at?.slice(0, 10)}`),
    ...(record.linked_objects ?? []).map((l) => `${l.relation}: ${l.identifier}${l.note ? ` — ${l.note}` : ""}`),
  ];
  return [
    "\n## Provenance\n",
    "| | |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| **${k}** | ${cell(v)} |`),
    links.length > 0 ? `\n### Linked objects\n\n${bullets(links)}\n` : "",
  ].join("\n");
}

/** Mutable trial fields always render with their observation stamp. */
function statusBlock(id, record) {
  const res = resolved[id];
  const observations = (res?.trials ?? [])
    .filter((t) => t.resolved)
    .map((t) => {
      const o = t.trial_status_observation ?? {};
      return `- **${t.nct}** — status \`${o.status ?? "unknown"}\`, enrollment ${o.enrollment ?? "unknown"} (${o.enrollment_type ?? "type not stated"}), phase ${(o.phase ?? []).join("/") || "unknown"}${o.why_stopped ? `, stopped: ${o.why_stopped}` : ""} · observed ${o.observed_at} from ${o.source}`;
    });
  const fromDoc = record.trial_status_observation;
  if (fromDoc?.status) {
    observations.push(`- **as stated in the retrieved document** — status \`${fromDoc.status}\`, enrollment ${fromDoc.enrollment ?? "not stated"} · observed ${fromDoc.observed_at ?? "date not stated"} from ${fromDoc.source ?? "the document"}`);
  }
  if (observations.length === 0) return "";
  return `\n## Trial status observations\n\n*Recruitment status, enrollment and phase change over time. Each value below is stamped with when it was observed and what stated it; none of them is a timeless fact.*\n\n${observations.join("\n")}\n`;
}

function renderPage(id, { record, final, fidelity, gates }) {
  const target = targets[id];
  const res = resolved[id];
  const title = val(record.title) ?? res?.identity?.title ?? target?.title ?? id;
  const year = res?.crossref?.published?.slice(0, 4) ?? res?.identity?.year ?? null;
  const authors = (record.authors ?? []).map((a) => a.name).filter(Boolean);
  const design = val(record.study?.design);
  const n = val(record.study?.n);
  const status = record.primary_endpoint_status?.status ?? "not recorded";

  const description = `${design ?? record.document_kind ?? "record"}${n ? `, n=${n}` : ""} — primary endpoint ${status}.`;

  const frontmatter = [
    "---",
    `title: ${yamlString(String(title).slice(0, 120))}`,
    `description: ${yamlString(description.slice(0, 200))}`,
    "type: paper",
    ...(year ? [`year: ${yamlString(year)}`, `date: ${year}-01-01`] : []),
    ...(res?.identity?.doi ? [`doi: ${yamlString(res.identity.doi)}`] : []),
    `license: ${yamlString(res?.identity?.license ?? res?.unpaywall?.oa_status ?? "unknown")}`,
    ...(authors[0] ? [`firstAuthor: ${yamlString(authors[0])}`] : []),
    ...(authors.length > 0
      ? ["authors:", ...(record.authors ?? []).filter((a) => a.name).map((a) => `  - name: ${yamlString(a.name)}${a.affiliation ? `\n    affiliation: ${yamlString(a.affiliation)}` : ""}`)]
      : []),
    "search:",
    `  tags: [${[target?.cluster, record.document_kind, status === "not_met" ? "negative-result" : null].filter(Boolean).map((t) => slugify(String(t))).join(", ")}]`,
    "---",
  ].join("\n");

  const studyRows = [
    ["Document kind", record.document_kind],
    ["Design", design],
    ["Phase", val(record.study?.phase)],
    ["N", n],
    ["What N counts", val(record.study?.n_description)],
    ["Population", val(record.study?.population)],
    ["Intervention", val(record.study?.intervention)],
    ["Comparator", val(record.study?.comparator)],
    ["Follow-up", val(record.study?.followup)],
    ["Biomarker confirmation", val(record.study?.biomarker_confirmation)],
    ["Cohorts / datasets used", (record.study?.cohorts ?? []).join(", ")],
  ];

  const outcomes = outcomesTable(record);
  const harms = harmsTable(record);

  return [
    frontmatter,
    "",
    `> **Primary endpoint: ${safe(status)}.** ${safe(record.primary_endpoint_status?.explanation ?? "")}`,
    "",
    "## Study\n",
    "| | |",
    "| --- | --- |",
    ...studyRows.filter(([, v]) => has(v)).map(([k, v]) => `| **${k}** | ${cell(v)} |`),
    outcomes ? `\n## Outcomes\n\n*Prespecified, exploratory, subgroup and post-hoc results are separated by tier. A subgroup or post-hoc row is never an endpoint that was "met".*\n\n${outcomes}\n` : "",
    harms ? `\n## Harms\n\n*Extracted separately from efficacy, as reported.*\n\n${harms}\n${record.safety?.apoe_stratification_reported ? "\nAPOE genotype-stratified safety data are reported in this document.\n" : ""}` : "",
    statusBlock(id, record),
    criticalReview(id, record, final, fidelity, gates),
    provenanceBlock(id, record),
    "\n---\n",
    `*Generated by the [research pipeline](https://github.com/msichterman/alzheimers-research/blob/main/PIPELINE.md) from the retrieved primary document. Structured record: \`enriched/${id}/09-record.json\`. Edit freely — republishing overwrites.*`,
    "",
  ]
    .filter((p) => p !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const ids = (onlyIds.length > 0 ? onlyIds : readdirSync(ENRICHED_DIR)).filter((id) =>
  existsSync(join(ENRICHED_DIR, id, "05-evidence.json")),
);

ensureDir(PAPERS_DIR);
let published = 0;
let held = 0;
for (const id of ids) {
  const gates = readJson(join(ENRICHED_DIR, id, "gates.json"));
  if (!gates?.passed && !includeQuarantined) {
    held++;
    continue;
  }
  const final = readJson(join(ENRICHED_DIR, id, "09-record.json"));
  const record = final?.record ?? readJson(join(ENRICHED_DIR, id, "05-evidence.json"));
  const fidelity = readJson(join(ENRICHED_DIR, id, "07-fidelity.json"));
  const slug = slugify(id);
  writeFileSync(join(PAPERS_DIR, `${slug}.mdx`), renderPage(id, { record, final, fidelity, gates }));
  published++;
  log(id, `wrote docs/research/papers/${slug}.mdx`);
}
log(null, `publish-evidence complete: ${published} page(s) written, ${held} held in quarantine`);
