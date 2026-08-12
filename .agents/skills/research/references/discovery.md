# Discovery playbook

How to find sources without hallucinating them. Prefer `pnpm discover` — its results come from APIs
and every identifier is real. Fall back to `WebSearch`/`WebFetch` only for the gaps listed at the
bottom.

## `pnpm discover`

```bash
pnpm discover "<query>" [--limit 15] [--since 2018] [--preprints]
                        [--sort relevance|cited|date] [--trials 10] [--no-trials]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--limit` | 15 | Literature hits. Capped at 25 by the API. |
| `--since` | none | Publication-year floor, e.g. `--since 2018`. |
| `--preprints` | off | Adds `SRC:PPR` (medRxiv/bioRxiv). Use for fast-moving topics only. |
| `--sort` | relevance | `cited` and `date` **override relevance entirely** — with a broad query they return famous-but-unrelated papers. Only use them with a tight query. |
| `--trials` | 10 | ClinicalTrials.gov hits. `--no-trials` to skip. |

Writes `discovery/<query-slug>.json`: every candidate with `score`, `verdict`, `reasons[]`,
`flags[]`, `excluded`/`exclusion_reason`, `pdf_url`, `suggested_slug`, `already_ingested`,
`already_cited`; plus registered trials with `already_documented`. Read the file — the terminal
output is a summary.

**Verdict bands:** `recommended` ≥55 · `consider` 35–54 · `skip` <35 · `excluded` (retracted —
never ingestable). Bands are a prior, not a decision; `references/source-tiers.md` decides.

### Writing queries

- Plain keywords, ANDed loosely, with synonym expansion on (so `buntanetap` also finds `posiphen`,
  `ANVS401`). Two to five content words works best.
- Quote phrases: `"amyloid cascade hypothesis"`. Beware Greek letters in titles (β vs beta) — try both.
- Europe PMC field syntax works: `AUTH:"Maccecchini M"`, `JOURNAL:"Alzheimers Dement"`,
  `EXT_ID:16541076` (PMID lookup), `DOI:"10.1002/trc2.12465"`.
- One query per subquestion. Five queries per round is the cap; more is churn, not coverage.
- **ClinicalTrials.gov ANDs every word**, so a long literature query returns no trials. If the
  registry section comes back empty, re-run with just the drug or condition (`pnpm discover
  "lecanemab" --limit 1`) to get the trial list.

### Reading it well

- 0 results → widen the query, drop `--since`, or add `--preprints`.
- Everything scoring identically → the query is too broad; add a distinguishing term.
- A whole page of `consider` conference abstracts → the readout has not been published as a full
  paper yet. That absence is a finding worth stating.
- `already_documented: false` on a trial → the trials section is missing a page; feed the NCT id
  into the pipeline (a document that reports it) or note it as a gap.

## APIs behind it

**Europe PMC** — `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=…&format=json&resultType=core`.
Covers PubMed (`SRC:MED`), PMC full text (`SRC:PMC`), preprints (`SRC:PPR`). No key, no rate limit
in practice. `resultType=core` is what carries `pubTypeList`, `commentCorrectionList` (retractions,
errata), `citedByCount`, and `fullTextUrlList` (the OA PDF).

**ClinicalTrials.gov API v2** — `https://clinicaltrials.gov/api/v2/studies?query.term=…&fields=…`.
Authoritative for status, phase, enrollment, sponsor, and dates. Registry beats paper beats press
release, always. Single record: `https://clinicaltrials.gov/api/v2/studies/NCT05686044`.

## Manual fallback

Use `WebSearch` / `WebFetch` for what the two APIs do not index:

- **Regulatory** — FDA approval letters, CRLs, AdComm briefing documents (`fda.gov`), EMA EPARs (`ema.europa.eu`).
- **Sponsor filings** — SEC 8-K/10-K for trial outcomes disclosed to investors before publication.
- **Expert reaction** — Alzforum news and comment threads.
- **Locating a PDF** for a paper Europe PMC has as metadata only (publisher site, institutional repository).

Rules when doing this by hand:

1. Only output URLs that appeared in a search result or a page you actually fetched.
2. Fetch the primary document before citing it. A search snippet is not a source.
3. Landing pages and abstracts do not go into `sources/` — `parse` handles PDF/DOCX/EPUB and friends,
   not HTML. They stay citations.
4. Anything found this way still passes through `references/source-tiers.md` before ingest.
