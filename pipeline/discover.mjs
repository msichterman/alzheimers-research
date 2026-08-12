#!/usr/bin/env node
// Find reputable sources for a topic and screen them before anything is ingested.
//   Europe PMC          peer-reviewed literature (MED/PMC) + preprints (PPR)
//   ClinicalTrials.gov  API v2 — the registry spine for the trials section
// Read-only: it ranks, flags, and excludes; it never downloads. Approved
// candidates are pulled in with `pnpm ingest <pdf-url> --name <slug>`.
// Writes discovery/<query-slug>.json (tracked — part of the evidence trail).
// Usage: pnpm discover "<query>" [--limit 15] [--since 2018] [--preprints]
//                      [--sort relevance|cited|date] [--trials 10] [--no-trials]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DOCS_DIR,
  ENRICHED_DIR,
  RAW_DIR,
  ROOT,
  SOURCES_DIR,
  log,
  slugify,
  writeJson,
} from "./lib.mjs";

const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const CTGOV = "https://clinicaltrials.gov/api/v2/studies";
const UA = "alzheimers-research-pipeline/1.0 (research knowledge base)";
const DISCOVERY_DIR = join(ROOT, "discovery");
const THIS_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const flagValues = new Set();
for (const name of ["limit", "since", "sort", "trials"]) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) flagValues.add(i + 1);
}
const query = argv.filter((a, i) => !a.startsWith("--") && !flagValues.has(i)).join(" ").trim();

if (!query) {
  console.error('Usage: pnpm discover "<query>" [--limit 15] [--since 2018] [--preprints] [--sort relevance|cited|date] [--trials 10] [--no-trials]');
  process.exit(1);
}

const limit = Math.min(Number(flag("limit", 15)), 25); // resultType=core caps at 25
const since = flag("since", null);
const sort = flag("sort", "relevance");
const trialLimit = has("no-trials") ? 0 : Number(flag("trials", 10));
const includePreprints = has("preprints");

if (!["relevance", "cited", "date"].includes(sort)) {
  console.error("--sort must be relevance, cited, or date");
  process.exit(1);
}

// ------------------------------------------------------------------- lookup

/** Everything we have already written about, so candidates can be marked as covered. */
function buildHaystack() {
  const chunks = [];
  const walk = (dir, match) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, match);
      else if (match.test(entry)) chunks.push(readFileSync(full, "utf8"));
    }
  };
  walk(DOCS_DIR, /\.mdx$/);
  walk(ENRICHED_DIR, /^0\d-.*\.json$/);
  return chunks.join("\n").toLowerCase();
}
const haystack = buildHaystack();
const covered = (...ids) =>
  ids.some((id) => id && haystack.includes(String(id).toLowerCase()));

/** Have we already ingested this exact document? Slugs are the pipeline's doc ids. */
function alreadyIngested(slug) {
  if (existsSync(join(RAW_DIR, slug))) return true;
  if (!existsSync(SOURCES_DIR)) return false;
  return readdirSync(SOURCES_DIR).some((name) => slugify(name) === slug);
}

async function getJson(url, label) {
  const response = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return response.json();
}

// ------------------------------------------------------------- europe pmc

const SORTS = { relevance: "", cited: "&sort=CITED%20desc", date: "&sort=P_PDATE_D%20desc" };

function epmcQuery() {
  const sources = includePreprints
    ? "(SRC:MED OR SRC:PMC OR SRC:PPR)"
    : "(SRC:MED OR SRC:PMC)";
  const window = since ? ` AND (FIRST_PDATE:[${since}-01-01 TO ${THIS_YEAR}-12-31])` : "";
  return `(${query}) AND ${sources}${window}`;
}

/** Screen and score one Europe PMC record. Every point is explained in `reasons`. */
function scoreArticle(record) {
  const pubTypes = (record.pubTypeList?.pubType ?? []).map((t) => String(t).toLowerCase());
  const corrections = record.commentCorrectionList?.commentCorrection ?? [];
  const isPreprint = record.source === "PPR";
  const journal = record.journalInfo?.journal;
  const reasons = [];
  const flags = [];

  // Hard exclusions come first — no score can rescue these.
  const retractionNotice = corrections.find((c) => /^retraction in/i.test(c.type || ""));
  if (pubTypes.includes("retracted publication") || retractionNotice) {
    return {
      excluded: true,
      exclusion_reason: `retracted${retractionNotice ? ` — see ${retractionNotice.reference}` : ""}`,
      score: 0,
      reasons,
      flags,
      pubTypes,
    };
  }
  if (pubTypes.includes("retraction of publication")) {
    return { excluded: true, exclusion_reason: "this record is a retraction notice, not a study", score: 0, reasons, flags, pubTypes };
  }

  let score = isPreprint ? 25 : 50;
  reasons.push(isPreprint ? "preprint (not peer reviewed): 25" : "peer-reviewed record: 50");

  const bump = (points, why) => {
    score += points;
    reasons.push(`${why}: ${points > 0 ? "+" : ""}${points}`);
  };

  // A conference abstract is a few hundred sponsor-written words with no methods
  // section and no peer review. Treat it as a pointer, never as evidence.
  const isConferenceAbstract =
    pubTypes.includes("abstract") || /suppl/i.test(record.journalInfo?.issue || "");
  if (isConferenceAbstract) {
    bump(-22, "conference abstract, not a full paper");
    flags.push("conference abstract — cite it for the claim's existence, not as evidence; look for the full paper");
  } else if (pubTypes.some((t) => /journal article|research-article/.test(t))) {
    bump(6, "full journal article");
  }

  if (pubTypes.some((t) => /randomized controlled trial|clinical trial/.test(t))) bump(10, "primary trial report");
  if (pubTypes.some((t) => /meta-analysis|systematic review/.test(t))) bump(8, "systematic review / meta-analysis");
  if (pubTypes.some((t) => /editorial|comment|letter|news|biography/.test(t))) {
    bump(-12, "editorial / comment / news");
    flags.push("editorial, letter, or commentary — opinion about evidence, not evidence");
  }
  if (!isPreprint && !journal?.nlmid) bump(-10, "journal not indexed in MEDLINE");

  const cited = Number(record.citedByCount || 0);
  if (cited > 0) bump(Math.min(12, Math.round(Math.log10(cited + 1) * 8)), `cited ${cited}x`);

  // PMC-sourced records often carry no pubYear (and yearOfPublication: 0) — fall back to the date.
  const year =
    Number(record.pubYear) ||
    Number(record.journalInfo?.yearOfPublication) ||
    Number(String(record.firstPublicationDate || "").slice(0, 4)) ||
    0;
  if (year && THIS_YEAR - year <= 3) bump(8, `published ${year}`);
  else if (year && THIS_YEAR - year <= 6) bump(4, `published ${year}`);

  const pdfUrl = (record.fullTextUrlList?.fullTextUrl ?? []).find(
    (u) => u.documentStyle === "pdf" && u.site === "Europe_PMC",
  )?.url ?? (record.fullTextUrlList?.fullTextUrl ?? []).find((u) => u.documentStyle === "pdf")?.url ?? null;
  if (pdfUrl) bump(6, "open-access PDF available");

  if (corrections.some((c) => /^(correction|erratum|expression of concern) in/i.test(c.type || ""))) {
    flags.push(`has a correction or expression of concern — ${corrections.map((c) => c.type).join(", ")}`);
  }
  if (isPreprint) flags.push("preprint — findings are not peer reviewed; label as such on any page");
  if (!pdfUrl) flags.push("no open-access PDF — cite and link it, but it cannot be parsed into raw/");

  return { excluded: false, exclusion_reason: null, score, reasons, flags, pubTypes, pdfUrl, year, cited };
}

async function findArticles() {
  const url =
    `${EPMC}?query=${encodeURIComponent(epmcQuery())}` +
    `&format=json&resultType=core&synonym=TRUE&pageSize=${limit}${SORTS[sort]}`;
  const data = await getJson(url, "Europe PMC");

  return (data.resultList?.result ?? []).map((record) => {
    const screened = scoreArticle(record);
    const slug = (record.title || record.id).split(/\s+/).slice(0, 8).map(slugify).filter(Boolean).join("-");
    const doi = record.doi || null;
    return {
      title: (record.title || "").replace(/\.$/, ""),
      authors: record.authorString || null,
      journal: record.journalInfo?.journal?.title || record.bookOrReportDetails?.publisher || null,
      year: screened.year || Number(record.pubYear) || null,
      published: record.firstPublicationDate || null,
      source: record.source,
      pmid: record.pmid || null,
      pmcid: record.pmcid || null,
      doi,
      doi_url: doi ? `https://doi.org/${doi}` : null,
      landing_url: record.pmcid
        ? `https://europepmc.org/article/${record.source}/${record.id}`
        : record.pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`
          : doi
            ? `https://doi.org/${doi}`
            : null,
      pdf_url: screened.pdfUrl || null,
      pub_types: screened.pubTypes,
      cited_by: screened.cited ?? Number(record.citedByCount || 0),
      open_access: record.isOpenAccess === "Y",
      score: screened.score,
      verdict: screened.excluded
        ? "excluded"
        : screened.score >= 55
          ? "recommended"
          : screened.score >= 35
            ? "consider"
            : "skip",
      excluded: screened.excluded,
      exclusion_reason: screened.exclusion_reason,
      reasons: screened.reasons,
      flags: screened.flags,
      suggested_slug: slug,
      already_ingested: alreadyIngested(slug),
      already_cited: covered(doi, record.pmid, record.pmcid),
    };
  });
}

// ------------------------------------------------------------ registry spine

async function findTrials() {
  if (trialLimit <= 0) return [];
  const fields = [
    "protocolSection.identificationModule",
    "protocolSection.statusModule",
    "protocolSection.designModule",
    "protocolSection.sponsorCollaboratorsModule",
    "protocolSection.conditionsModule",
  ].join(",");
  const url =
    `${CTGOV}?query.term=${encodeURIComponent(query)}` +
    `&pageSize=${trialLimit}&countTotal=true&fields=${fields}`;
  const data = await getJson(url, "ClinicalTrials.gov");

  return (data.studies ?? []).map((study) => {
    const p = study.protocolSection ?? {};
    const nctId = p.identificationModule?.nctId;
    return {
      nct_id: nctId,
      registry_url: `https://clinicaltrials.gov/study/${nctId}`,
      title: p.identificationModule?.briefTitle || null,
      status: p.statusModule?.overallStatus || null,
      phase: (p.designModule?.phases ?? []).join("/") || null,
      enrollment: p.designModule?.enrollmentInfo?.count ?? null,
      sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name || null,
      sponsor_class: p.sponsorCollaboratorsModule?.leadSponsor?.class || null,
      conditions: p.conditionsModule?.conditions ?? [],
      started: p.statusModule?.startDateStruct?.date || null,
      primary_completion: p.statusModule?.primaryCompletionDateStruct?.date || null,
      last_update: p.statusModule?.lastUpdatePostDateStruct?.date || null,
      already_documented: covered(nctId),
    };
  });
}

// --------------------------------------------------------------------- run

log(null, `discovering sources for: ${query}`);
const [articleResult, trialResult] = await Promise.allSettled([findArticles(), findTrials()]);

if (articleResult.status === "rejected") log(null, `Europe PMC FAILED: ${articleResult.reason.message}`);
if (trialResult.status === "rejected") log(null, `ClinicalTrials.gov FAILED: ${trialResult.reason.message}`);

const articles = (articleResult.status === "fulfilled" ? articleResult.value : []).sort(
  (a, b) => b.score - a.score,
);
const trials = trialResult.status === "fulfilled" ? trialResult.value : [];

const report = {
  query,
  run_at: new Date().toISOString(),
  options: { limit, since, sort, preprints: includePreprints, trials: trialLimit },
  apis: {
    literature: "Europe PMC REST (search, resultType=core, synonym=TRUE)",
    registry: "ClinicalTrials.gov API v2",
  },
  scoring: "excluded < skip(<35) < consider(35-54) < recommended(>=55); see .claude/skills/research/references/source-tiers.md",
  counts: {
    articles: articles.length,
    recommended: articles.filter((a) => a.verdict === "recommended").length,
    excluded: articles.filter((a) => a.excluded).length,
    trials: trials.length,
    trials_undocumented: trials.filter((t) => !t.already_documented).length,
  },
  articles,
  trials,
};

const outPath = join(DISCOVERY_DIR, `${slugify(query) || "query"}.json`);
writeJson(outPath, report);

// --------------------------------------------------------------- human view

const mark = (a) =>
  a.excluded ? "EXCLUDED" : a.already_ingested ? "HAVE IT " : a.verdict.toUpperCase().padEnd(8);

console.log("");
for (const a of articles) {
  console.log(`${mark(a)} ${String(a.score).padStart(3)}  ${a.year ?? "----"}  ${a.title.slice(0, 96)}`);
  console.log(`         ${a.journal ?? "unknown venue"}${a.doi ? ` · ${a.doi}` : ""}${a.cited_by ? ` · cited ${a.cited_by}x` : ""}`);
  if (a.excluded) console.log(`         ! ${a.exclusion_reason}`);
  for (const f of a.flags) console.log(`         ~ ${f}`);
  if (!a.excluded && !a.already_ingested && a.pdf_url && a.verdict !== "skip") {
    console.log(`         pnpm ingest "${a.pdf_url}" --name ${a.suggested_slug}`);
  }
  if (a.already_cited && !a.already_ingested) console.log("         (already cited somewhere in docs/ or enriched/)");
  console.log("");
}

if (trials.length === 0 && trialLimit > 0 && trialResult.status === "fulfilled") {
  console.log("Registered trials: none matched. ClinicalTrials.gov ANDs every word — retry with just the drug or condition.\n");
} else if (trials.length > 0) {
  console.log("Registered trials:");
  for (const t of trials) {
    console.log(
      `  ${t.already_documented ? "documented" : "NEW       "} ${t.nct_id}  ${t.status ?? "?"}${t.phase ? ` · phase ${t.phase}` : ""} · ${t.sponsor ?? "?"}`,
    );
    console.log(`             ${(t.title ?? "").slice(0, 96)}`);
  }
  console.log("");
}

log(null, `${report.counts.recommended} recommended of ${articles.length} article(s), ${report.counts.trials_undocumented} undocumented trial(s) -> ${outPath.slice(ROOT.length + 1)}`);
if (articles.length === 0 && articleResult.status === "fulfilled") {
  log(null, "no literature matched — widen the query, drop --since, or try --preprints");
}
log(null, "next: screen against the source-tier policy, then `pnpm ingest <pdf-url> --name <slug>` and `pnpm research`");
