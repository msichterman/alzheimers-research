#!/usr/bin/env node
// The validation gates. Nothing reaches docs/ without passing every one of them.
//
//   identity     the identifiers resolve, and the title agrees across sources
//   file         real bytes, stored SHA-256, and a genuine extracted text layer
//   evidence     design, N, population, comparator, primary endpoint, effect,
//                prespecified-vs-post-hoc separation, harms separated from efficacy
//   fidelity     the independent critic agrees, and every value is locatable
//   provenance   canonical URL, legal access route, licence, timestamps, funding
//   cross-links  paper <-> registry <-> regulator, and corrections linked
//   critical review  present and complete — a hard gate, not optional prose
//
// A failure is not a warning. It writes enriched/<id>/gates.json with
// passed:false and the record goes to quarantine with the reason recorded.
//
// Usage: node pipeline/validate.mjs [id...] [--cluster <name>]
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENRICHED_DIR, RAW_DIR, ROOT, SOURCES_DIR, log, readJson, writeJson } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const argv = process.argv.slice(2);
const clusterIndex = argv.indexOf("--cluster");
const onlyCluster = clusterIndex >= 0 ? argv[clusterIndex + 1] : null;
const onlyIds = argv.filter((a, i) => !a.startsWith("--") && (clusterIndex === -1 || i !== clusterIndex + 1));

const targets = Object.fromEntries((readJson(join(CORPUS_DIR, "targets.json"))?.targets ?? []).map((t) => [t.id, t]));
const resolved = readJson(join(CORPUS_DIR, "resolved.json"))?.records ?? {};
const acquired = readJson(join(CORPUS_DIR, "acquired.json"))?.records ?? {};

const has = (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
const val = (node) => (node && typeof node === "object" && "value" in node ? node.value : node);

/**
 * A parsed document is "full text" only if it actually contains the sections an
 * evidence extraction needs. A PubMed abstract deposit passes every byte-level
 * check and then yields a record whose primary endpoint came from two sentences,
 * which is precisely the failure the fidelity bar punishes.
 */
function textSufficiency(markdown, kind, targetType) {
  const chars = markdown.length;
  const sections = ["method", "result", "discussion", "statistical analysis", "outcome", "participants"].filter((s) =>
    new RegExp(`^#{1,4}\\s.*${s}|\\*\\*${s}`, "im").test(markdown),
  );
  // A registry protocol or a regulator's notice is complete at a length that
  // would mean "abstract only" for a journal article, so it is judged on its own
  // terms — using the work order's declared type, which is known before any
  // extraction has happened.
  if (targetType === "registry" || targetType === "regulatory" || kind === "registry_record" || kind === "regulatory_recall" || kind === "regulatory_label") {
    return { level: chars > 1500 ? "structured-record" : "thin", chars, sections };
  }
  // A structured abstract carries the same section headings as a full paper —
  // Methods, Results, Conclusions — in a couple of thousand characters. Heading
  // count alone therefore cannot tell them apart, and length has to be the floor.
  // This is not academic: the blind A/B lost SPRINT MIND and U.S. POINTER because
  // their records were built from structured abstracts that passed as full text.
  if (chars < 9000) return { level: "abstract-only", chars, sections };
  if (chars < 20000 && sections.length < 3) return { level: "partial-text", chars, sections };
  return { level: "full-text", chars, sections };
}

function gatesFor(id) {
  const target = targets[id];
  const res = resolved[id];
  const acq = acquired[id];
  // The final record is the builder's extraction with every adjudicated conflict
  // resolved. Before adjudication has run, the builder's own file is validated so
  // the other gates still report — but the fidelity gate below will hold it.
  const finalRecord = readJson(join(ENRICHED_DIR, id, "09-record.json"));
  const evidence = finalRecord?.record ?? readJson(join(ENRICHED_DIR, id, "05-evidence.json"));
  const fidelity = readJson(join(ENRICHED_DIR, id, "07-fidelity.json"));
  const failures = [];
  const warnings = [];
  const manifestDiscrepancies = [];
  const fail = (gate, detail) => failures.push({ gate, detail });
  const warn = (gate, detail) => warnings.push({ gate, detail });

  // ---------------------------------------------------------------- identity
  const identifiers = [
    res?.identity?.doi ? { kind: "doi", value: res.identity.doi, resolved: Boolean(res.crossref) } : null,
    res?.identity?.pmid ? { kind: "pmid", value: res.identity.pmid, resolved: Boolean(res.pubmed) } : null,
    res?.identity?.pmcid ? { kind: "pmcid", value: res.identity.pmcid, resolved: true } : null,
    ...(res?.trials ?? []).map((t) => ({ kind: "nct", value: t.nct, resolved: t.resolved })),
    ...(res?.regulatory_checks ?? []).map((c) => ({ kind: "regulatory-url", value: c.url, resolved: c.ok })),
  ].filter(Boolean);
  if (identifiers.length === 0) fail("identity", "no identifier of any kind resolved for this record");
  for (const identifier of identifiers.filter((i) => !i.resolved)) {
    fail("identity", `${identifier.kind} ${identifier.value} did not resolve live`);
  }
  // Title agreement across two independent metadata sources.
  const titles = [res?.identity?.title, res?.crossref?.title, res?.pubmed?.title].filter(Boolean);
  if (titles.length >= 2) {
    const key = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!titles.every((t) => key(t).slice(0, 60) === key(titles[0]).slice(0, 60))) {
      warn("identity", `metadata sources disagree on the title: ${titles.map((t) => `"${String(t).slice(0, 60)}"`).join(" vs ")}`);
    }
  } else if (target?.type !== "registry" && target?.type !== "regulatory") {
    warn("identity", "only one metadata source carried a title — cross-source title agreement could not be checked");
  }

  // -------------------------------------------------------------------- file
  const primary = acq?.primary;
  if (!primary) fail("file", "no primary document acquired");
  else {
    if (!primary.sha256) fail("file", "no SHA-256 stored for the acquired file");
    const absolute = join(ROOT, primary.path);
    if (!existsSync(absolute)) fail("file", `acquired file is missing from disk: ${primary.path}`);
    else if (statSync(absolute).size === 0) fail("file", "acquired file is empty");
    if (primary.extension === ".pdf") {
      const head = existsSync(absolute) ? readFileSync(absolute).subarray(0, 5).toString("latin1") : "";
      if (!head.startsWith("%PDF")) fail("file", "file claims to be a PDF but does not carry a PDF header");
    }
  }
  // The parsed document is named after the file that was acquired, which for a
  // registry-primary record is "<id>-<nct>", not "<id>". Deriving the path from
  // the acquisition record rather than the target id keeps the two in step.
  const rawId = primary?.path
    ? primary.path.replace(/^sources\//, "").replace(/\.[a-z0-9]+$/i, "")
    : id;
  const rawPath = existsSync(join(RAW_DIR, rawId, "document.md"))
    ? join(RAW_DIR, rawId, "document.md")
    : join(RAW_DIR, id, "document.md");
  let sufficiency = null;
  if (!existsSync(rawPath)) fail("file", "no extracted text layer at raw/<id>/document.md");
  else {
    const markdown = readFileSync(rawPath, "utf8");
    sufficiency = textSufficiency(markdown, evidence?.document_kind, target?.type);
    if (sufficiency.level === "abstract-only") {
      fail("file", `extracted text is abstract-only (${sufficiency.chars} chars, sections: ${sufficiency.sections.join("/") || "none"}) — not sufficient for an evidence record`);
    } else if (sufficiency.level === "partial-text" || sufficiency.level === "thin") {
      warn("file", `extracted text looks partial (${sufficiency.chars} chars, sections: ${sufficiency.sections.join("/") || "none"})`);
    }
  }

  // ---------------------------------------------------------------- evidence
  if (!evidence) fail("evidence", "no evidence record extracted (enriched/<id>/05-evidence.json missing)");
  else {
    const isTrial = ["rct", "registry"].includes(target?.type) || ["journal_article", "registry_record"].includes(evidence.document_kind);
    if (!has(val(evidence.study?.design))) fail("evidence", "study design not identified");
    if (!has(val(evidence.study?.population))) fail("evidence", "population not located in the primary source");
    if (isTrial && !has(val(evidence.study?.n))) {
      warn("evidence", "N not located in the primary source — acceptable only if the document genuinely does not state one");
    }
    const outcomes = evidence.outcomes ?? [];
    const primaryOutcomes = outcomes.filter((o) => o.tier === "primary");
    // A pooled safety analysis or a secondary report has no primary endpoint of
    // its own, and says so. Requiring one would force an extractor to invent it.
    const noPrimaryByDesign = evidence.primary_endpoint_status?.status === "not_applicable";
    if (isTrial && primaryOutcomes.length === 0 && !noPrimaryByDesign) fail("evidence", "no primary outcome identified");
    if (!has(evidence.primary_endpoint_status?.status)) fail("evidence", "primary endpoint status not labelled");
    if (isTrial && !has(val(evidence.study?.comparator)) && evidence.document_kind !== "registry_record") {
      warn("evidence", "comparator not located");
    }
    for (const outcome of primaryOutcomes) {
      if (!has(outcome.effect_estimate) && outcome.met !== "not_applicable") {
        warn("evidence", `primary outcome "${outcome.name}" has no effect estimate`);
      }
    }
    // Prespecified and post-hoc must be separated, and post-hoc must never be
    // described in met-endpoint language.
    const mislabelled = outcomes.filter((o) => ["post_hoc", "subgroup"].includes(o.tier) && ["met", "not_met"].includes(o.met));
    for (const outcome of mislabelled) {
      fail("evidence", `"${outcome.name}" is tier ${outcome.tier} but carries met="${outcome.met}" — post-hoc and subgroup results may not use outcome language`);
    }
    if (outcomes.some((o) => o.prespecified === "yes" && !has(o.prespecification_evidence))) {
      warn("evidence", "an outcome is marked prespecified without supporting text from the document");
    }
    // Harms are extracted separately from efficacy.
    if (!evidence.safety) fail("evidence", "no safety section extracted");
    else if (isTrial && (evidence.safety.harms ?? []).length === 0 && !(evidence.unlocatable_fields ?? []).some((f) => /harm|safety|adverse|aria/i.test(f))) {
      warn("evidence", "no harms extracted and none declared unlocatable");
    }
  }

  // ---------------------------------------------------------------- fidelity
  if (!fidelity) fail("fidelity", "no independent critic pass (enriched/<id>/07-fidelity.json missing)");
  else {
    if (fidelity.builder_values_not_found_in_document.length > 0) {
      fail(
        "fidelity",
        `${fidelity.builder_values_not_found_in_document.length} value(s) could not be located in the retrieved text: ${fidelity.builder_values_not_found_in_document.slice(0, 3).map((v) => v.path).join(", ")}`,
      );
    }
    // A conflict is only cleared once a blind adjudicator has ruled on it against
    // the document. An unruled conflict, or one whose ruling could not be applied,
    // holds the record.
    if ((fidelity.conflicts ?? 0) > 0 && !finalRecord) {
      fail("fidelity", `${fidelity.conflicts} unadjudicated conflict(s) between the builder and the independent critic`);
    } else if (finalRecord && finalRecord.conflicts_unresolved > 0) {
      fail(
        "fidelity",
        `${finalRecord.conflicts_unresolved} conflict(s) reached no adjudicator ruling: ${finalRecord.unresolved.slice(0, 3).map((u) => `${u.field} (${u.reason})`).join("; ")}`,
      );
    }
    if (finalRecord?.conflicts_needing_manual_apply > 0) {
      warn(
        "fidelity",
        `${finalRecord.conflicts_needing_manual_apply} adjudicated ruling(s) could not be applied automatically and need a hand edit: ${(finalRecord.needs_manual_apply ?? []).map((u) => u.field).join(", ")}`,
      );
    }
    const noPrimary = evidence?.primary_endpoint_status?.status === "not_applicable";
    const criticalGaps = (fidelity.all_rows ?? [])
      .filter((r) => r.kind === "coverage-gap" && r.critical)
      // Where the document has no primary endpoint, the primary-outcome fields
      // are empty on both sides by design, not by omission.
      .filter((r) => !(noPrimary && r.field.startsWith("outcomes[primary]")))
      // A gap already ruled on by the adjudicator is settled.
      .filter((r) => !(finalRecord?.adjudication_changelog ?? []).some((c) => c.field === r.field));
    if (criticalGaps.length > 0) {
      fail("fidelity", `the two extractions disagree on whether the document reports: ${criticalGaps.map((r) => r.field).join(", ")}`);
    }
  }

  // -------------------------------------------------------------- provenance
  if (!has(res?.identity?.doi) && !has((res?.trials ?? [])[0]?.nct) && !has((res?.regulatory_checks ?? [])[0]?.url)) {
    fail("provenance", "no canonical identifier preserved");
  }
  if (primary && !has(primary.url)) fail("provenance", "no legal access route recorded");
  if (primary && !has(primary.tier)) fail("provenance", "acquisition tier not recorded");
  if (!has(acq?.acquired_at)) fail("provenance", "no retrieval timestamp");
  if (!has(res?.unpaywall?.oa_status) && !has(res?.identity?.license) && target?.type !== "regulatory" && target?.type !== "registry") {
    warn("provenance", "licence/open-access status not recorded");
  }
  if (evidence && (evidence.funding ?? []).length === 0 && !(evidence.unlocatable_fields ?? []).some((f) => /funding/i.test(f))) {
    warn("provenance", "no funding captured and none declared unlocatable");
  }
  if (evidence && (evidence.conflicts ?? []).length === 0 && !(evidence.unlocatable_fields ?? []).some((f) => /conflict/i.test(f))) {
    warn("provenance", "no conflicts captured and none declared unlocatable");
  }

  // -------------------------------------------------------------- cross-links
  const registryLinks = (res?.trials ?? []).filter((t) => t.resolved).map((t) => t.nct);
  const claimedNct = (val(evidence?.study?.nct_ids) ?? evidence?.study?.nct_ids ?? []).filter(Boolean);
  if (target?.type === "rct" && registryLinks.length === 0 && claimedNct.length === 0) {
    warn("cross-links", "a randomized trial record with no registry counterpart linked");
  }
  for (const nct of claimedNct) {
    if (!registryLinks.includes(nct)) {
      warn("cross-links", `document names ${nct} but no resolved registry record is linked for it`);
    }
  }
  if (res?.correction && !(evidence?.linked_objects ?? []).some((l) => l.relation === "correction")) {
    fail("cross-links", `a published correction exists (${res.correction.doi}) but is not linked on the record`);
  }
  for (const finding of (res?.findings ?? []).filter((f) => f.kind === "linked-object")) {
    if (!(evidence?.linked_objects ?? []).some((l) => String(l.identifier).toLowerCase() === String(finding.identifier).toLowerCase())) {
      warn("cross-links", `Crossref reports a relation to ${finding.identifier} that the record does not link`);
    }
  }

  // ---------------------------------------------------- critical review (hard)
  if (!evidence) fail("critical-review", "no record to review");
  else {
    const review = {
      primary_endpoint_status: has(evidence.primary_endpoint_status?.status),
      multiplicity: has(evidence.multiplicity?.approach),
      limitations: (evidence.limitations ?? []).length > 0,
      risk_of_bias: (evidence.risk_of_bias ?? []).length > 0,
      funding_or_declared_absent: (evidence.funding ?? []).length > 0 || (evidence.unlocatable_fields ?? []).some((f) => /funding/i.test(f)),
      unlocatable_declared: Array.isArray(evidence.unlocatable_fields),
    };
    for (const [part, ok] of Object.entries(review)) {
      if (!ok) fail("critical-review", `critical review is incomplete: ${part.replace(/_/g, " ")} is missing`);
    }
  }

  // ------------------------------------------- manifest versus retrieved source
  // The work order is never evidence. Its numbers are compared to the record
  // only to record where it was wrong.
  const claims = target?.manifest_claims ?? {};
  if (evidence) {
    const extractedN = val(evidence.study?.n);
    if (has(claims.n) && has(extractedN) && Number(claims.n) !== Number(extractedN)) {
      manifestDiscrepancies.push({
        field: "n",
        work_order_says: claims.n,
        source_says: extractedN,
        detail: `work order states N=${claims.n}; the retrieved document states N=${extractedN}. The document wins.`,
      });
    }
    if (has(claims.outcome) && evidence.primary_endpoint_status?.status === "not_met" && /significant|slowed|improved|met|benefit/i.test(String(claims.outcome)) && !/not |no |fail/i.test(String(claims.outcome))) {
      manifestDiscrepancies.push({
        field: "primary_endpoint",
        work_order_says: claims.outcome,
        source_says: "not_met",
        detail: "work order describes a positive result; the retrieved document records the primary endpoint as not met.",
      });
    }
  }

  return {
    id,
    cluster: target?.cluster ?? acq?.cluster ?? null,
    checked_at: new Date().toISOString(),
    passed: failures.length === 0,
    text_sufficiency: sufficiency,
    evidence_completeness: acq?.evidence_completeness ?? "none",
    failures,
    warnings,
    manifest_discrepancies: manifestDiscrepancies,
  };
}

const ids = Object.keys(acquired).filter(
  (id) => (onlyIds.length === 0 || onlyIds.includes(id)) && (!onlyCluster || acquired[id].cluster === onlyCluster),
);

let passed = 0;
const quarantine = [];
for (const id of ids) {
  const report = gatesFor(id);
  writeJson(join(ENRICHED_DIR, id, "gates.json"), report);
  if (report.passed) {
    passed++;
    log(id, `gates PASS${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ""}`);
  } else {
    quarantine.push({ id, stage: "validation", reason: report.failures.map((f) => f.gate).join(", "), detail: report.failures.map((f) => f.detail).join(" · ") });
    log(id, `gates FAIL: ${report.failures.map((f) => `${f.gate}: ${f.detail}`).join(" | ").slice(0, 220)}`);
  }
}

writeJson(join(CORPUS_DIR, "quarantine.json"), { generated_at: new Date().toISOString(), entries: quarantine });
log(null, `validate complete: ${passed}/${ids.length} passed, ${quarantine.length} quarantined`);
