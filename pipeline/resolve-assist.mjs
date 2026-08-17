#!/usr/bin/env node
// Grounded-search assist for targets the deterministic resolver could not
// identify, or that ended up with no usable access route.
//
// This produces LEADS, not facts. Gemini is asked, with Google Search grounding,
// for the identifiers and legal full-text routes of a paper described by the work
// order. Whatever comes back is written into pipeline/corpus/leads.json and then
// fed through pipeline/resolve.mjs, where Crossref, Europe PMC, NCBI and
// ClinicalTrials.gov decide whether it is real. A model's recall never reaches a
// record without a service confirming it first.
//
// Usage: node pipeline/resolve-assist.mjs [targetId...] [--all-gaps]
import { join } from "node:path";
import { GEMINI_AVAILABLE, MODELS, S, gemini } from "./gemini.mjs";
import { ROOT, log, mapLimit, readJson, writeJson } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const LEADS = join(CORPUS_DIR, "leads.json");

if (!GEMINI_AVAILABLE) {
  log(null, "no Vertex credentials (run: gcloud auth application-default login) — skipping grounded resolution assist");
  process.exit(0);
}

const argv = process.argv.slice(2);
const allGaps = argv.includes("--all-gaps");
const onlyIds = argv.filter((a) => !a.startsWith("--"));

const { targets } = readJson(join(CORPUS_DIR, "targets.json"));
const resolved = readJson(join(CORPUS_DIR, "resolved.json"))?.records ?? {};
const acquired = readJson(join(CORPUS_DIR, "acquired.json"))?.records ?? {};

const SCHEMA = S.obj(
  {
    doi: S.str("DOI of the version of record, lowercase, no URL prefix"),
    pmid: S.str("PubMed ID, digits only"),
    pmcid: S.str("PubMed Central ID including the PMC prefix"),
    exact_title: S.str("the article's exact published title"),
    journal: S.str("journal name"),
    year: S.str("publication year of the version of record"),
    first_author: S.str("first author, family name and initials"),
    nct_ids: S.arr(S.str("NCT identifier"), "registered trial identifiers reported in this paper"),
    open_access_urls: S.arr(
      S.str("a direct legal full-text URL: PubMed Central, Europe PMC, a publisher open-access PDF, or an institutional repository copy"),
      "legal open-access routes, best first; never a pirated mirror such as Sci-Hub, and never ResearchGate or Academia.edu",
    ),
    regulatory_urls: S.arr(S.str("an FDA or EMA document URL for this programme"), "regulator documents, if any"),
    confidence: S.str("high, medium or low — how sure you are this is the paper described"),
    disambiguation_note: S.str("if the description could match more than one paper, say which and why you chose this one"),
  },
  ["doi", "exact_title", "confidence"],
);

function promptFor(target, record) {
  const failed = (acquired[target.id]?.attempts ?? [])
    .filter((a) => !a.ok)
    .map((a) => `- ${a.kind}: ${a.http_status ?? ""} ${a.reason ?? ""}`.trim())
    .join("\n");
  return `Identify one specific scholarly article and find legal open-access routes to its full text.

The article is described in an acquisition work order as:
  title (may be paraphrased): ${target.title}
  authors (hint): ${target.authors ?? "unknown"}
  year (hint): ${target.year ?? "unknown"}
  study type (hint): ${target.type}
  topic cluster: ${target.cluster}

${record?.rejected_candidate ? `An automated lookup considered "${record.rejected_candidate.title}" (${record.rejected_candidate.year}, ${record.rejected_candidate.doi ?? "no DOI"}) and rejected it as a poor match. Do not return that unless you are confident it is right.\n` : ""}${failed ? `These acquisition routes have already been tried and failed:\n${failed}\n` : ""}
Rules:
- Search before answering. Do not answer from memory.
- The work order's title and year may be wrong or paraphrased. The real published title wins.
- Return null for anything you cannot confirm from a search result. A null is correct; a guess is not.
- open_access_urls must be legal: PubMed Central, Europe PMC, a publisher open-access PDF, a funder or institutional repository. Never a pirated mirror. Never ResearchGate or Academia.edu. Never a press release or news article.
- If the paper genuinely has no legal open-access copy, return an empty array rather than inventing one.`;
}

const gaps = targets.filter((t) => {
  if (onlyIds.length > 0) return onlyIds.includes(t.id);
  if (!allGaps) return false;
  const r = resolved[t.id];
  const a = acquired[t.id];
  const unresolved = !r?.identity && t.type !== "registry" && t.type !== "regulatory";
  const noRoutes = (r?.access_plan ?? []).length === 0;
  const noPrimary = !a?.primary;
  const substitute = a?.evidence_completeness === "registry-substitute";
  return unresolved || noRoutes || noPrimary || substitute;
});

log(null, `grounded assist for ${gaps.length} target(s) using ${MODELS.pro}`);

const leads = readJson(LEADS)?.leads ?? {};
const results = await mapLimit(gaps, 3, async (target) => {
  const answer = await gemini(promptFor(target, resolved[target.id]), {
    model: MODELS.pro,
    grounded: true,
    maxOutputTokens: 8192,
  });
  // Grounded search and a forced JSON schema cannot be combined, so the shape is
  // requested in the prompt and parsed defensively here.
  let parsed = null;
  try {
    const text = answer.text.replace(/^```(?:json)?/m, "").replace(/```$/m, "");
    const start = text.indexOf("{");
    parsed = start === -1 ? null : JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
  } catch {
    parsed = null;
  }
  return {
    id: target.id,
    lead: parsed,
    raw: parsed ? null : answer.text.slice(0, 2000),
    grounding_citations: answer.citations,
    model: answer.model,
    generated_at: new Date().toISOString(),
    status: "unverified-lead",
  };
});

let ok = 0;
results.forEach((result, i) => {
  if (result.error) {
    log(gaps[i].id, `assist FAILED: ${result.error.message}`);
    return;
  }
  const { id, lead } = result.value;
  leads[id] = result.value;
  ok++;
  log(
    id,
    lead
      ? `lead: ${lead.doi ?? "no doi"} (${lead.confidence ?? "?"}) · ${(lead.open_access_urls ?? []).length} OA route(s) · ${result.value.grounding_citations.length} citation(s)`
      : "lead: unparseable response",
  );
});

writeJson(LEADS, {
  generated_at: new Date().toISOString(),
  note: "Unverified leads from grounded search. Every field must be re-verified by pipeline/resolve.mjs against Crossref/Europe PMC/NCBI/ClinicalTrials.gov before use.",
  leads,
});
log(null, `resolve-assist complete: ${ok}/${gaps.length} leads written to pipeline/corpus/leads.json`);
log(null, "next: node pipeline/apply-leads.mjs  (merges verified leads into targets, then re-resolve)");
