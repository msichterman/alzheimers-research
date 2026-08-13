#!/usr/bin/env node
// Resolve every identifier in pipeline/corpus/targets.json against live services
// before anything is acquired. Nothing here trusts the work order: a DOI, PMID,
// PMCID, NCT id or regulatory URL is only usable once the service returns it.
//
//   DOI    -> Crossref (canonical bibliographic identity) + Unpaywall (legal OA)
//   PMID   -> NCBI ESummary, batched through one request per 150 ids
//   any    -> Europe PMC (PMID/PMCID linkage, open-access flag, full-text routes)
//   NCT    -> ClinicalTrials.gov API v2, stored with an observation timestamp
//   URL    -> live GET, recording the status and final URL after redirects
//
// Writes pipeline/corpus/resolved.json. A non-resolving identifier is recorded
// as a finding, never silently dropped and never published.
//
// Usage: node pipeline/resolve.mjs [targetId...] [--force]
import { join } from "node:path";
import { CONTACT, eutils, fetchJson, fetchText, politeFetch, titleSimilarity } from "./net.mjs";
import { ROOT, log, mapLimit, readJson, writeJson } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const OUT = join(CORPUS_DIR, "resolved.json");
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const onlyIds = argv.filter((a) => !a.startsWith("--"));

const { targets } = readJson(join(CORPUS_DIR, "targets.json"));
const previous = force ? {} : (readJson(OUT)?.records ?? {});

const nowIso = () => new Date().toISOString();

/** Europe PMC core record for a query, best hit first. */
async function epmcSearch(query) {
  const url = `${EPMC}/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=10`;
  const { ok, data } = await fetchJson(url);
  if (!ok) return [];
  return data?.resultList?.result ?? [];
}

function epmcIdentity(hit) {
  const fullTextUrls = (hit.fullTextUrlList?.fullTextUrl ?? []).map((u) => ({
    url: u.url,
    documentStyle: u.documentStyle,
    site: u.site,
    availability: u.availability,
  }));
  return {
    source: hit.source,
    pmid: hit.pmid ?? null,
    pmcid: hit.pmcid ?? null,
    doi: hit.doi ? hit.doi.toLowerCase() : null,
    title: hit.title ?? null,
    journal: hit.journalInfo?.journal?.title ?? hit.bookOrReportDetails?.publisher ?? null,
    year: hit.pubYear ?? null,
    first_publication_date: hit.firstPublicationDate ?? null,
    authors: hit.authorString ?? null,
    publication_types: hit.pubTypeList?.pubType ?? [],
    is_open_access: hit.isOpenAccess === "Y",
    in_epmc: hit.inEPMC === "Y",
    in_pmc: hit.inPMC === "Y",
    license: hit.license ?? null,
    has_corrections: hit.hasSuppl === "Y" ? null : null,
    full_text_urls: fullTextUrls,
  };
}

async function crossref(doi) {
  const { ok, data } = await fetchJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CONTACT)}`,
  );
  if (!ok) return null;
  const m = data.message;
  const dateParts = (m.published?.["date-parts"] ?? m.issued?.["date-parts"] ?? [[]])[0];
  return {
    doi: m.DOI?.toLowerCase() ?? null,
    title: Array.isArray(m.title) ? m.title[0] : m.title,
    container: Array.isArray(m["container-title"]) ? m["container-title"][0] : null,
    published: dateParts.filter(Boolean).map((p) => String(p).padStart(2, "0")).join("-") || null,
    type: m.type ?? null,
    volume: m.volume ?? null,
    page: m.page ?? null,
    authors: (m.author ?? []).map((a) => ({
      family: a.family ?? null,
      given: a.given ?? null,
      orcid: a.ORCID ?? null,
      affiliations: (a.affiliation ?? []).map((x) => x.name).filter(Boolean),
    })),
    license: (m.license ?? []).map((l) => ({ url: l.URL, start: l.start?.["date-time"] ?? null })),
    /** Crossref carries update-to/update-by relations: corrections, retractions, concerns. */
    update_to: (m["update-to"] ?? []).map((u) => ({ doi: u.DOI, type: u.type, label: u.label })),
    relations: Object.keys(m.relation ?? {}),
  };
}

async function unpaywall(doi) {
  const { ok, data } = await fetchJson(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(CONTACT)}`,
  );
  if (!ok) return null;
  return {
    is_oa: Boolean(data.is_oa),
    oa_status: data.oa_status ?? null,
    journal_is_oa: Boolean(data.journal_is_oa),
    locations: (data.oa_locations ?? []).map((l) => ({
      host_type: l.host_type,
      version: l.version,
      license: l.license,
      url_for_pdf: l.url_for_pdf,
      url_for_landing_page: l.url_for_landing_page,
      repository_institution: l.repository_institution,
    })),
  };
}

async function pubmedSummary(pmids) {
  if (pmids.length === 0) return {};
  const out = {};
  for (let i = 0; i < pmids.length; i += 150) {
    const batch = pmids.slice(i, i + 150);
    const { ok, data } = await fetchJson(
      eutils("esummary.fcgi", { db: "pubmed", id: batch.join(","), retmode: "json" }),
    );
    if (!ok) continue;
    for (const uid of data.result?.uids ?? []) {
      const r = data.result[uid];
      out[uid] = {
        pmid: uid,
        title: r.title ?? null,
        journal: r.source ?? null,
        pubdate: r.pubdate ?? null,
        authors: (r.authors ?? []).map((a) => a.name),
        doi: (r.articleids ?? []).find((a) => a.idtype === "doi")?.value?.toLowerCase() ?? null,
        pmcid: (r.articleids ?? []).find((a) => a.idtype === "pmcid")?.value ?? null,
        pubtypes: r.pubtype ?? [],
      };
    }
  }
  return out;
}

/**
 * ClinicalTrials.gov v2 study record. Mutable fields (status, enrollment, phase)
 * are returned wrapped in an observation stamp so nothing downstream can state
 * them as timeless facts.
 */
async function clinicalTrial(nct) {
  const { ok, status, data } = await fetchJson(`https://clinicaltrials.gov/api/v2/studies/${nct}`);
  if (!ok) return { nct, resolved: false, http_status: status };
  const p = data.protocolSection ?? {};
  return {
    nct,
    resolved: true,
    observed_at: nowIso(),
    source: "ClinicalTrials.gov API v2",
    brief_title: p.identificationModule?.briefTitle ?? null,
    official_title: p.identificationModule?.officialTitle ?? null,
    sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
    has_results: Boolean(data.hasResults),
    last_update_posted: p.statusModule?.lastUpdatePostDateStruct?.date ?? null,
    trial_status_observation: {
      status: p.statusModule?.overallStatus ?? null,
      why_stopped: p.statusModule?.whyStopped ?? null,
      enrollment: p.designModule?.enrollmentInfo?.count ?? null,
      enrollment_type: p.designModule?.enrollmentInfo?.type ?? null,
      phase: p.designModule?.phases ?? null,
      observed_at: nowIso(),
      source: "ClinicalTrials.gov API v2",
    },
  };
}

async function headCheck(url) {
  const response = await politeFetch(url, { method: "GET", headers: { range: "bytes=0-2047" } });
  return {
    url,
    ok: response.ok,
    http_status: response.status,
    final_url: response.url,
    content_type: response.headers.get("content-type"),
    checked_at: nowIso(),
  };
}

/**
 * Acquisition order, as a ranked plan rather than a single URL:
 *   regulator/registry -> PMC or publisher OA -> legal institutional AM -> landing page.
 * Each entry records why it sits where it does, so a record can say which tier
 * it was actually acquired from.
 */
function accessPlan(target, { epmc, upw }) {
  const plan = [];
  const push = (tier, kind, url, note) => {
    if (url && !plan.some((p) => p.url === url)) plan.push({ tier, kind, url, note });
  };

  // A URL from the work order is only tier 1 when the target really is a
  // regulator's document. Everywhere else it is just a publisher-OA hint and
  // has to queue behind PMC like any other tier-2 route.
  const isRegulatory = target.type === "regulatory";
  const urlTier = isRegulatory ? 1 : 2;
  const urlKind = isRegulatory ? "regulator" : "publisher-oa-pdf";
  if (target.candidates?.url) push(urlTier, urlKind, target.candidates.url, `work-order endpoint, verified live (${isRegulatory ? "regulator" : "publisher OA"})`);
  if (target.candidates?.alt_url) push(urlTier, urlKind, target.candidates.alt_url, "alternate work-order endpoint");
  for (const nct of target.candidates?.nct ?? []) {
    push(1, "registry", `https://clinicaltrials.gov/api/v2/studies/${nct}`, "official structured trial record");
  }

  if (epmc?.pmcid) {
    push(2, "pmc-xml", `${EPMC}/${epmc.pmcid}/fullTextXML`, "Europe PMC full text (open-access subset)");
    // Author-manuscript deposits are legal full text that sits outside Europe
    // PMC's open-access subset, so the XML route 404s on them. NCBI's E-utilities
    // serve the same deposits over the documented, rate-limited API — the web
    // interface answers a generic client with a bot challenge, the API does not.
    push(2, "pmc-efetch", eutils("efetch.fcgi", { db: "pmc", id: epmc.pmcid.replace(/^PMC/i, ""), retmode: "xml" }), "PubMed Central via E-utilities (includes NIH author manuscripts)");
  }
  for (const location of upw?.locations ?? []) {
    if (location.host_type !== "publisher") continue;
    push(2, "publisher-oa-pdf", location.url_for_pdf, `Unpaywall publisher OA (${location.version ?? "?"}, ${location.license ?? "no licence stated"})`);
    push(2, "publisher-oa-landing", location.url_for_landing_page, `Unpaywall publisher OA landing (${location.version ?? "?"})`);
  }
  for (const location of upw?.locations ?? []) {
    if (location.host_type === "publisher") continue;
    push(3, "repository-am", location.url_for_pdf, `Unpaywall repository copy (${location.version ?? "?"}${location.repository_institution ? `, ${location.repository_institution}` : ""})`);
    push(3, "repository-landing", location.url_for_landing_page, "Unpaywall repository landing page");
  }
  for (const ft of epmc?.full_text_urls ?? []) {
    if (ft.availability === "Subscription required") continue;
    // Only PDF routes: Europe PMC's own article pages are client-rendered, so
    // fetching one returns a JavaScript shell that would pass an HTTP check and
    // fail every evidence gate afterwards.
    if (ft.documentStyle !== "pdf") continue;
    push(ft.site === "PubMedCentral" ? 2 : 3, "epmc-pdf", ft.url, `Europe PMC PDF (${ft.site}, ${ft.availability})`);
  }

  const doi = epmc?.doi ?? target.candidates?.doi;
  if (doi) push(4, "publisher-landing", `https://doi.org/${doi}`, "canonical DOI landing page (last resort)");
  return plan;
}

async function resolveTarget(target) {
  const findings = [];
  const record = {
    id: target.id,
    rank: target.rank,
    cluster: target.cluster,
    type: target.type,
    resolved_at: nowIso(),
    identity: null,
    crossref: null,
    unpaywall: null,
    pubmed: null,
    trials: [],
    regulatory_checks: [],
    access_plan: [],
    findings,
  };

  // 1. Registry records first: they resolve independently of any paper.
  for (const nct of target.candidates?.nct ?? []) {
    const trial = await clinicalTrial(nct);
    record.trials.push(trial);
    if (!trial.resolved) {
      findings.push({ kind: "unresolved-identifier", identifier: nct, detail: `ClinicalTrials.gov returned HTTP ${trial.http_status}` });
    }
  }

  // 2. Regulatory/direct URLs: verified live, status recorded either way.
  for (const url of [target.candidates?.url, target.candidates?.alt_url].filter(Boolean)) {
    const check = await headCheck(url);
    record.regulatory_checks.push(check);
    if (!check.ok) {
      findings.push({ kind: "unresolved-url", identifier: url, detail: `HTTP ${check.http_status}` });
    }
  }

  // 3. Scholarly identity. Try the strongest candidate we have, then fall back
  //    to a title search — never to a remembered identifier.
  let hits = [];
  const c = target.candidates ?? {};
  // A regulator's decision or a registry protocol has no scholarly identity;
  // searching a bibliographic index for one only invents a false match.
  const scholarly = target.type !== "regulatory" && target.type !== "registry";
  if (c.doi) hits = await epmcSearch(`DOI:"${c.doi}"`);
  if (hits.length === 0 && c.pmid) hits = await epmcSearch(`EXT_ID:${c.pmid} AND SRC:MED`);
  if (hits.length === 0 && c.pmcid) hits = await epmcSearch(`PMCID:${c.pmcid}`);
  // Free-text search is the weakest route, so it is narrowed by first author and
  // publication year before it is allowed to name a record.
  const surname = (target.authors ?? "").match(/^([A-Z][a-zA-Z'-]+(?: van| de)?)/)?.[1] ?? null;
  const cleanTitle = (target.title ?? "").replace(/["':]/g, "");
  if (hits.length === 0 && scholarly && target.title) {
    const narrow = [
      `TITLE:"${cleanTitle}"`,
      surname && target.year ? `TITLE:"${cleanTitle}" AND AUTH:"${surname}" AND PUB_YEAR:${target.year}` : null,
      surname ? `TITLE:"${cleanTitle}" AND AUTH:"${surname}"` : null,
      surname && target.year
        ? `${cleanTitle.split(/\s+/).slice(0, 10).join(" ")} AND AUTH:"${surname}" AND PUB_YEAR:${target.year}`
        : null,
      cleanTitle.split(/\s+/).slice(0, 12).join(" "),
    ].filter(Boolean);
    for (const query of narrow) {
      hits = await epmcSearch(query);
      if (hits.length > 0) break;
    }
  }

  if (hits.length > 0) {
    // Prefer the hit whose title actually matches the work order's hint, with
    // author and year as corroboration.
    const scored = hits
      .map((hit) => {
        const score = titleSimilarity(hit.title, target.title);
        const authorMatch = Boolean(
          surname && new RegExp(`\\b${surname}\\b`, "i").test(hit.authorString ?? ""),
        );
        const yearMatch = Boolean(target.year && Math.abs(Number(hit.pubYear) - Number(target.year)) <= 1);
        return { hit, score, authorMatch, yearMatch };
      })
      .sort((a, b) => b.score + (b.authorMatch ? 0.2 : 0) - (a.score + (a.authorMatch ? 0.2 : 0)));
    const best = scored[0];
    // Accept on a strong title match alone, or on a moderate one corroborated
    // by both the first author and the publication year. Anything weaker is a
    // finding, not a record — an unresolved target is far cheaper than a
    // confidently wrong one.
    const identifiedByCandidate = Boolean(c.doi || c.pmid || c.pmcid);
    const accepted =
      identifiedByCandidate || best.score >= 0.75 || (best.score >= 0.5 && best.authorMatch && best.yearMatch);
    if (!accepted) {
      findings.push({
        kind: "unresolved-identity",
        identifier: target.id,
        detail: `no confident Europe PMC match; best hit "${best.hit.title}" (${best.hit.pubYear}) scored ${best.score.toFixed(2)}${best.authorMatch ? ", author matched" : ", author did not match"}. Needs agent resolution before ingestion.`,
      });
      record.rejected_candidate = { title: best.hit.title, doi: best.hit.doi ?? null, year: best.hit.pubYear ?? null, score: Number(best.score.toFixed(2)) };
      hits = [];
    } else {
    record.identity = epmcIdentity(best.hit);
    record.identity.title_match_to_work_order = Number(best.score.toFixed(2));
    record.identity.author_hint_matched = best.authorMatch;
    record.identity.year_hint_matched = best.yearMatch;
    if (best.score < 0.6) {
      findings.push({
        kind: "weak-title-match",
        identifier: record.identity.doi ?? record.identity.pmid,
        detail: `identity accepted from a supplied identifier, but its title "${record.identity.title}" matches the work-order hint at only ${best.score.toFixed(2)} — confirm the work order named the right paper`,
      });
    }
    if (c.doi && record.identity.doi && c.doi.toLowerCase() !== record.identity.doi) {
      findings.push({
        kind: "manifest-vs-source",
        identifier: c.doi,
        detail: `work order lists DOI ${c.doi}; the resolved record for this title carries ${record.identity.doi}`,
      });
    }
    if (c.pmcid && record.identity.pmcid && c.pmcid !== record.identity.pmcid) {
      findings.push({ kind: "manifest-vs-source", identifier: c.pmcid, detail: `work order lists ${c.pmcid}; resolved record carries ${record.identity.pmcid}` });
    }
    }
  }
  if (!record.identity && scholarly && !findings.some((f) => f.kind === "unresolved-identity")) {
    findings.push({ kind: "unresolved-identity", identifier: target.id, detail: "no Europe PMC record found from DOI, PMID, PMCID or title search" });
  }

  // Europe PMC's core record does not always surface a PMC deposit, and NIH-funded
  // work is frequently in PMC even when the journal version is gated. The NCBI ID
  // converter is the authoritative check, so it runs before anything is called
  // paywalled.
  if (record.identity && !record.identity.pmcid) {
    const ids = [record.identity.doi, record.identity.pmid].filter(Boolean).join(",");
    if (ids) {
      const { ok, data } = await fetchJson(
        `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(ids)}&format=json&tool=alzheimers-research&email=${encodeURIComponent(CONTACT)}`,
      );
      const found = ok ? (data.records ?? []).find((r) => r.pmcid) : null;
      if (found?.pmcid) {
        record.identity.pmcid = found.pmcid;
        record.identity.pmcid_source = "NCBI ID converter";
        if (!record.identity.pmid && found.pmid) record.identity.pmid = found.pmid;
      }
    }
  }

  const doi = record.identity?.doi ?? c.doi ?? null;
  if (doi) {
    record.crossref = await crossref(doi);
    if (!record.crossref) {
      findings.push({ kind: "unresolved-identifier", identifier: doi, detail: "Crossref has no record for this DOI" });
    }
    record.unpaywall = await unpaywall(doi);
  }
  if (record.identity?.pmid) {
    record.pubmed = (await pubmedSummary([record.identity.pmid]))[record.identity.pmid] ?? null;
    if (!record.pubmed) {
      findings.push({ kind: "unresolved-identifier", identifier: record.identity.pmid, detail: "NCBI ESummary returned no record for this PMID" });
    }
  }

  // A published correction/retraction is a linked object, never a replacement.
  if (record.crossref?.update_to?.length) {
    for (const update of record.crossref.update_to) {
      findings.push({ kind: "linked-object", identifier: update.doi, detail: `${update.type}: this record updates ${update.doi} (${update.label ?? ""})`.trim() });
    }
  }
  if (c.correction_doi) {
    const correction = await crossref(c.correction_doi);
    record.correction = correction
      ? { doi: c.correction_doi, title: correction.title, published: correction.published, type: correction.type }
      : null;
    if (!correction) findings.push({ kind: "unresolved-identifier", identifier: c.correction_doi, detail: "correction DOI did not resolve at Crossref" });
  }

  record.access_plan = accessPlan(target, { epmc: record.identity, upw: record.unpaywall });
  if (record.access_plan.length === 0) {
    findings.push({ kind: "no-access-route", identifier: target.id, detail: "no regulator, registry, OA or landing-page route found" });
  }
  return record;
}

const queue = targets.filter(
  (t) => (onlyIds.length === 0 || onlyIds.includes(t.id)) && (force || !previous[t.id]),
);
log(null, `resolving ${queue.length} target(s) of ${targets.length}`);

const records = { ...previous };
const results = await mapLimit(queue, 4, async (target) => {
  const record = await resolveTarget(target);
  const identity = record.identity?.doi ?? record.identity?.pmid ?? record.trials[0]?.nct ?? "—";
  log(target.id, `resolved ${identity} · ${record.access_plan.length} access route(s) · ${record.findings.length} finding(s)`);
  return record;
});

let failed = 0;
results.forEach((result, i) => {
  if (result.error) {
    failed++;
    log(queue[i].id, `FAILED: ${result.error.message}`);
    return;
  }
  records[result.value.id] = result.value;
});

const allFindings = Object.values(records).flatMap((r) =>
  r.findings.map((f) => ({ target: r.id, ...f })),
);
writeJson(OUT, { generated_at: nowIso(), count: Object.keys(records).length, records });
log(null, `resolve complete: ${Object.keys(records).length} records, ${failed} failed, ${allFindings.length} findings`);
for (const finding of allFindings.filter((f) => f.kind !== "linked-object")) {
  log(null, `  ${finding.kind}: ${finding.target} — ${finding.detail}`);
}
