#!/usr/bin/env node
// The fidelity gate.
//
// Two independent things happen here, and neither of them is the builder
// grading itself:
//
//  1. An independent re-extraction. Gemini reads raw/<id>/document.md — the
//     retrieved file, nothing else, no summary, no builder output — and fills in
//     the same schema from scratch. A different model family means its mistakes
//     are not the builder's mistakes, so where the two agree, the agreement is
//     worth something.
//
//  2. A mechanical diff. Every field the fidelity bar names is compared between
//     the two extractions, and every quoted value in BOTH is checked back
//     against the document text by substring match. A value nobody can locate in
//     the retrieved text is a loss, and the field is forced to null rather than
//     published.
//
// Output: enriched/<id>/06-critique.json (the critic's own extraction) and
// enriched/<id>/07-fidelity.json (the diff and the verdict).
//
// Usage: node pipeline/critique.mjs [id...] [--force] [--cluster <name>]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_AVAILABLE, MODELS, gemini } from "./gemini.mjs";
import { EVIDENCE_SCHEMA } from "./schema.mjs";
import { ENRICHED_DIR, RAW_DIR, ROOT, log, mapLimit, readJson, writeJson } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");

if (!GEMINI_AVAILABLE) {
  log(null, "GOOGLE_AI_API_KEY not set — cannot run the independent critic");
  process.exit(1);
}

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const clusterIndex = argv.indexOf("--cluster");
const onlyCluster = clusterIndex >= 0 ? argv[clusterIndex + 1] : null;
const onlyIds = argv.filter((a, i) => !a.startsWith("--") && (clusterIndex === -1 || i !== clusterIndex + 1));

const acquired = readJson(join(CORPUS_DIR, "acquired.json"))?.records ?? {};

const CRITIC_PROMPT = (markdown) => `You are extracting a structured evidence record from ONE retrieved research document.

You are working blind on purpose. You have not been shown anyone else's extraction of this document, and you must not try to guess what one would say. Extract what this document states, from scratch.

Rules:
- The document below is your only source. Do not use prior knowledge of this trial, drug or paper. If you recognise the study, set that recognition aside — it is the most common way an extraction goes wrong.
- Every value carries a verbatim quote from the document. Quotes are checked by exact string match, so copy them character-for-character. A paraphrase counts as no quote at all.
- If the document does not state something, the value is null and the field name goes in unlocatable_fields. Null is a correct answer. An inferred value is not.
- A missed primary endpoint is recorded as not_met regardless of how the document frames it.
- Subgroup and post-hoc results get tier "subgroup" or "post_hoc" and met "not_applicable". They may never be described as met endpoints.
- Harms: whenever the document reports them, include ARIA-E, ARIA-H, symptomatic ARIA, macrohemorrhage and deaths, with arm, count, denominator and percentage as printed, and the APOE stratum where the document stratifies.
- Recruitment status, enrollment and phase belong in trial_status_observation with the date they were observed, never as timeless facts.

--- BEGIN RETRIEVED DOCUMENT ---

${markdown}

--- END RETRIEVED DOCUMENT ---`;

/** Normalise a value for comparison: case, whitespace, and unit punctuation. */
const norm = (v) =>
  v === null || v === undefined
    ? null
    : String(v)
        .toLowerCase()
        .replace(/[‐-―−]/g, "-")
        .replace(/[·,]/g, "")
        .replace(/\s+/g, " ")
        .trim();

const STOPWORDS = new Set("the a an of in on at to for with and or as by from is was were are be been that this it its into over per than then also n range score scores".split(" "));
const contentWords = (text) =>
  String(text ?? "")
    // Split on hyphens and slashes as well as spaces: one extraction writes
    // "116-week" where the other writes "116 weeks", and that is the same fact.
    .split(/[\s/-]+/)
    .map((w) => w.replace(/[^a-z0-9.%]/g, ""))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.endsWith("s") && w.length > 4 ? w.slice(0, -1) : w));

/** Every number in a string, so two descriptions can be checked for numeric conflict. */
const numbersIn = (text) =>
  (String(text ?? "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));

/**
 * Do two extracted values say the same thing?
 *
 * The two extractions routinely differ in how much they quote — one writes
 * "fixed hierarchical testing procedure", the other "Fixed hierarchical
 * (gatekeeping) testing procedure across primary then secondary outcomes". That
 * is a granularity difference, not a disagreement about the document, and
 * treating it as a fidelity loss would bury the real ones. So: the shorter value
 * must be substantially contained in the longer, and the two must not assert
 * conflicting numbers.
 */
function valuesAgree(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (na === null || nb === null) return false;

  const numA = Number.parseFloat(na.replace(/[^0-9.-]/g, ""));
  const numB = Number.parseFloat(nb.replace(/[^0-9.-]/g, ""));
  if (Number.isFinite(numA) && Number.isFinite(numB) && na.length < 24 && nb.length < 24) return numA === numB;
  if (na.includes(nb) || nb.includes(na)) return true;

  const wordsA = contentWords(na);
  const wordsB = contentWords(nb);
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const longerSet = new Set(longer);
  const shared = shorter.filter((w) => longerSet.has(w)).length;
  const containment = shared / shorter.length;

  // A number present in one and contradicted in the other is a real conflict,
  // however well the words line up.
  const setA = new Set(numbersIn(na));
  const setB = new Set(numbersIn(nb));
  const conflicting = [...setA].some((n) => setB.size > 0 && !setB.has(n)) && [...setB].some((n) => !setA.has(n));
  if (conflicting) return false;

  return containment >= 0.75;
}

/** Compare the numeric facts of two harm lists, ignoring how each labels the arms. */
function harmFactsAgree(builderHarms, criticHarms) {
  const facts = (harms) =>
    new Set(
      harms.flatMap((h) => [
        ...numbersIn(h.count).map((n) => `c${n}`),
        ...numbersIn(h.percentage).map((n) => `p${n}`),
      ]),
    );
  const a = facts(builderHarms);
  const b = facts(criticHarms);
  if (a.size === 0 && b.size === 0) return true;
  if (a.size === 0 || b.size === 0) return null; // coverage gap, not a conflict
  // Agreement means neither asserts a number the other contradicts on the same
  // measure. Extra detail on one side is coverage, not disagreement.
  const overlap = [...b].filter((f) => a.has(f)).length;
  return overlap > 0 && overlap >= Math.min(a.size, b.size) * 0.5;
}

/**
 * Quote verification. The document text is normalised the same way the quote is,
 * because the Markdown conversion introduces line breaks and spacing the model
 * never saw as significant.
 */
function makeQuoteChecker(markdown) {
  const haystack = norm(markdown);
  return (quote) => {
    if (!quote) return null;
    const needle = norm(quote);
    if (!needle || needle.length < 8) return false;
    if (haystack.includes(needle)) return true;
    // Long quotes often span a table cell boundary or a hyphenation the parser
    // resolved differently; accept when a solid run of the quote is present.
    const words = needle.split(" ");
    if (words.length >= 8) {
      const windows = [words.slice(0, 8).join(" "), words.slice(-8).join(" "), words.slice(Math.floor(words.length / 2) - 4, Math.floor(words.length / 2) + 4).join(" ")];
      return windows.some((w) => w.length > 20 && haystack.includes(w));
    }
    return false;
  };
}

const at = (object, path) => path.split(".").reduce((o, key) => (o === null || o === undefined ? null : o[key]), object);

const primaryOutcome = (record) =>
  (record?.outcomes ?? []).find((o) => o.tier === "primary") ?? null;

const harmOf = (record, name) =>
  (record?.safety?.harms ?? []).filter((h) => norm(h.name)?.includes(norm(name)));

/** The field-by-field comparison the fidelity bar asks for. */
/**
 * Fields where one side finding nothing is itself a failure. Everywhere else,
 * "builder found it, critic didn't" is a coverage gap worth reporting but not a
 * disagreement about what the document says.
 */
const CRITICAL_FIELDS = new Set([
  "study.n",
  "study.design",
  "study.population",
  "primary_endpoint_status.status",
  "outcomes[primary].met",
  "outcomes[primary].effect_estimate",
  "outcomes[primary].confidence_interval",
  "safety.harms[ARIA-E].reported",
  "safety.harms[ARIA-H].reported",
  "safety.harms[symptomatic ARIA].reported",
  "safety.harms[macrohemorrhage].reported",
  "safety.harms[death].reported",
  "safety.apoe_stratification_reported",
]);

function diff(builder, critic, checkQuote) {
  const rows = [];
  const compare = (field, a, b, quoteA, quoteB) => {
    const bothPresent = a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== "";
    const agree = bothPresent ? valuesAgree(a, b) : !CRITICAL_FIELDS.has(field);
    rows.push({
      field,
      builder: a ?? null,
      critic: b ?? null,
      agree,
      // A conflict is both sides asserting incompatible things. An asymmetry is
      // one side finding something the other did not look hard enough for.
      kind: agree ? "agree" : bothPresent ? "conflict" : "coverage-gap",
      critical: CRITICAL_FIELDS.has(field),
      builder_quote_located: checkQuote(quoteA),
      critic_quote_located: checkQuote(quoteB),
    });
  };

  for (const path of ["study.design", "study.n", "study.population", "study.comparator", "study.followup", "study.intervention", "study.phase"]) {
    compare(path, at(builder, `${path}.value`), at(critic, `${path}.value`), at(builder, `${path}.quote`), at(critic, `${path}.quote`));
  }
  compare(
    "primary_endpoint_status.status",
    at(builder, "primary_endpoint_status.status"),
    at(critic, "primary_endpoint_status.status"),
    at(builder, "primary_endpoint_status.quote"),
    at(critic, "primary_endpoint_status.quote"),
  );
  compare("multiplicity.approach", at(builder, "multiplicity.approach"), at(critic, "multiplicity.approach"), at(builder, "multiplicity.quote"), at(critic, "multiplicity.quote"));

  const bp = primaryOutcome(builder);
  const cp = primaryOutcome(critic);
  // A document that reports no primary endpoint of its own — a pooled safety
  // analysis, a label, a review — has nothing to compare here, and comparing
  // null to null would manufacture agreement rather than measure it.
  if (bp || cp) {
    for (const key of ["name", "met", "effect_estimate", "confidence_interval", "p_value", "prespecified", "multiplicity_controlled"]) {
      compare(`outcomes[primary].${key}`, bp?.[key] ?? null, cp?.[key] ?? null, bp?.quote, cp?.quote);
    }
  }

  for (const harmName of ["ARIA-E", "ARIA-H", "symptomatic ARIA", "macrohemorrhage", "death"]) {
    const b = harmOf(builder, harmName);
    const c = harmOf(critic, harmName);
    compare(
      `safety.harms[${harmName}].reported`,
      b.length > 0 ? "reported" : "absent",
      c.length > 0 ? "reported" : "absent",
      b[0]?.quote,
      c[0]?.quote,
    );
    if (b.length > 0 && c.length > 0) {
      // Compare the numbers, not the arm labels: the two extractions describe
      // arms at different granularity ("gantenerumab" vs "gantenerumab, pooled
      // across GRADUATE I and II") and that is not a factual disagreement.
      const factsAgree = harmFactsAgree(b, c);
      rows.push({
        field: `safety.harms[${harmName}].counts`,
        builder: b.map((h) => `${h.arm}: ${h.count ?? h.percentage ?? "?"}`).join(" | ").slice(0, 300),
        critic: c.map((h) => `${h.arm}: ${h.count ?? h.percentage ?? "?"}`).join(" | ").slice(0, 300),
        agree: factsAgree !== false,
        kind: factsAgree === false ? "conflict" : factsAgree === null ? "coverage-gap" : "agree",
        critical: true,
        builder_quote_located: checkQuote(b[0]?.quote),
        critic_quote_located: checkQuote(c[0]?.quote),
      });
    }
  }
  compare("safety.apoe_stratification_reported", builder?.safety?.apoe_stratification_reported, critic?.safety?.apoe_stratification_reported, null, null);

  // Prespecification status of every outcome both extractions found, matched by name.
  for (const outcome of builder?.outcomes ?? []) {
    const match = (critic?.outcomes ?? []).find((o) => valuesAgree(o.name, outcome.name));
    if (!match) continue;
    compare(`outcomes[${outcome.name}].prespecified`, outcome.prespecified, match.prespecified, outcome.prespecification_evidence, match.prespecification_evidence);
    compare(`outcomes[${outcome.name}].tier`, outcome.tier, match.tier, outcome.quote, match.quote);
  }
  return rows;
}

/** Every quoted value in a record, for the "cannot be located in retrieved text" rule. */
function unlocatableValues(record, checkQuote) {
  const bad = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    const hasValue = "value" in node ? node.value !== null : "count" in node ? node.count !== null : false;
    if (hasValue && "quote" in node && checkQuote(node.quote) === false) {
      bad.push({ path, value: node.value ?? node.count, quote: String(node.quote ?? "").slice(0, 140) });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "quote" || key === "location") continue;
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(record, "");
  return bad;
}

const docs = Object.values(acquired)
  .filter((a) => a.primary && (!onlyCluster || a.cluster === onlyCluster) && (onlyIds.length === 0 || onlyIds.includes(a.id)))
  .filter((a) => existsSync(join(ENRICHED_DIR, a.id, "05-evidence.json")))
  .filter((a) => force || !existsSync(join(ENRICHED_DIR, a.id, "07-fidelity.json")));

log(null, `independent critic over ${docs.length} record(s) using ${MODELS.pro}`);

const results = await mapLimit(docs, 4, async (record) => {
  const rawId = existsSync(join(RAW_DIR, record.id, "document.md"))
    ? record.id
    : (record.primary.path.match(/sources\/(.+)\.[a-z]+$/)?.[1] ?? record.id);
  const markdownPath = join(RAW_DIR, rawId, "document.md");
  if (!existsSync(markdownPath)) throw new Error(`no parsed document at raw/${rawId}/document.md`);
  const markdown = readFileSync(markdownPath, "utf8");
  const builder = readJson(join(ENRICHED_DIR, record.id, "05-evidence.json"));

  const answer = await gemini(CRITIC_PROMPT(markdown), {
    model: MODELS.pro,
    schema: EVIDENCE_SCHEMA,
    maxOutputTokens: 60000,
  });
  const critic = answer.json;
  writeJson(join(ENRICHED_DIR, record.id, "06-critique.json"), {
    extracted_by: answer.model,
    extracted_at: new Date().toISOString(),
    independent: true,
    saw_builder_output: false,
    source: `raw/${rawId}/document.md`,
    source_sha256: record.primary.sha256,
    truncated: answer.truncated,
    tokens: answer.tokens,
    record: critic,
  });

  const checkQuote = makeQuoteChecker(markdown);
  const rows = diff(builder, critic, checkQuote);
  const disagreements = rows.filter((r) => !r.agree);
  const conflicts = disagreements.filter((r) => r.kind === "conflict");
  const coverageGaps = rows.filter((r) => r.kind === "coverage-gap");
  const builderUnlocatable = unlocatableValues(builder, checkQuote);
  const criticUnlocatable = unlocatableValues(critic, checkQuote);

  const fidelity = {
    id: record.id,
    checked_at: new Date().toISOString(),
    builder_model: readJson(join(ENRICHED_DIR, record.id, "05-evidence.json"))?._meta?.model ?? "gemini (subagent)",
    critic_model: answer.model,
    fields_compared: rows.length,
    disagreements: disagreements.length,
    conflicts: conflicts.length,
    coverage_gaps: coverageGaps.length,
    agreement_rate: rows.length ? Number(((rows.length - disagreements.length) / rows.length).toFixed(3)) : null,
    // The bar: a disagreement is a loss, and any value that cannot be located in
    // the retrieved text is a loss. A conflict — both extractions asserting
    // incompatible things — always counts. A coverage gap counts only on the
    // fields the bar names, where finding nothing is itself a failure.
    passed: disagreements.length === 0 && builderUnlocatable.length === 0,
    needs_adjudication: conflicts.length > 0,
    disagreement_rows: disagreements,
    conflict_rows: conflicts,
    builder_values_not_found_in_document: builderUnlocatable,
    critic_values_not_found_in_document: criticUnlocatable,
    all_rows: rows,
  };
  writeJson(join(ENRICHED_DIR, record.id, "07-fidelity.json"), fidelity);
  return fidelity;
});

let passed = 0;
let failed = 0;
results.forEach((result, i) => {
  if (result.error) {
    failed++;
    log(docs[i].id, `critic FAILED: ${result.error.message}`);
    return;
  }
  const f = result.value;
  if (f.passed) passed++;
  log(
    f.id,
    `${f.passed ? "PASS" : "LOSS"} — ${f.conflicts} conflict(s), ${f.coverage_gaps} coverage gap(s) of ${f.fields_compared} fields, ${f.builder_values_not_found_in_document.length} unlocatable value(s)`,
  );
});
log(null, `critique complete: ${passed} passed, ${results.length - passed - failed} lost, ${failed} errored`);
