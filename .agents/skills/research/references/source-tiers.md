# Source-tier policy

What is allowed to become a page in this knowledge base, and what is only allowed to be a link.
`pnpm discover` automates the mechanical parts of this (scores, retraction exclusion); this file is
the judgement it cannot make.

## Tiers

| Tier | Source | Use |
| --- | --- | --- |
| 1 | Peer-reviewed primary research: RCT reports, cohort studies, replication attempts, autopsy series | Ingest. This is what pages are built from. |
| 1 | Registry records — ClinicalTrials.gov, EudraCT, jRCT | Ground truth for trial facts. Trial pages must match the registry, not the paper. |
| 1 | Regulatory documents — FDA approval letters, advisory-committee briefing docs, EMA EPARs, FDA CRLs | Ingest or cite. Primary and authoritative. |
| 2 | Systematic reviews and meta-analyses in indexed journals | Ingest. Strong for "what does the field think", weak for new effects. |
| 2 | Narrative reviews, consensus/criteria statements (NIA-AA, DLB Consortium) | Ingest when the topic *is* the framework. Otherwise a link. |
| 3 | Preprints — medRxiv, bioRxiv (Europe PMC `SRC:PPR`) | Ingest only for a genuinely new result with no peer-reviewed version. Label "preprint, not peer reviewed" on every page that uses it. Re-check for the published version later. |
| 3 | Conference abstracts (CTAD, AAIC, `Alzheimer's & Dementia` supplements) | Usually a link, not an ingest. A few hundred sponsor-written words, no methods, no review. Ingest only when it is the *only* record of a readout — and say so. |
| 4 | Trade and science press — STAT, Alzforum, Endpoints, Science news | Never evidence. Use to *find* the tier-1 source, and to characterise perception. Alzforum comment threads are useful signal about expert reaction. |
| 4 | Company press releases, investor decks, earnings calls | Never evidence. They are the claim, not the support. Follow to the registry record or paper. If a claim exists only in a press release, that fact is itself the finding — record it as one. |
| — | Reddit, forums, X, YouTube | Never evidence. Stage `03-sentiment` samples these deliberately, framed as perception. Never promote them out of that frame. |

## Hard exclusions — never ingest, never cite as support

1. **Retracted publications.** `pnpm discover` excludes these automatically (Europe PMC pubType
   `Retracted Publication`, or a `Retraction in` correction). A retracted paper may still be
   *discussed as a retraction* — that is a legitimate timeline milestone — with the retraction
   notice linked and the original clearly marked retracted.
2. **Predatory or unindexed venues.** No MEDLINE `nlmid`, no editorial board, author-pays with no
   review. `discover` applies a penalty; you make the call. Check the journal on
   [DOAJ](https://doaj.org) or NLM Catalog if unsure.
3. **Supplement, clinic, and product marketing** presented as research.
4. **Secondary coverage standing in for a primary source** — a news article about a trial is not the trial.
5. **Anything whose identifiers cannot be verified.** No DOI, no PMID, no registry id, no fetchable
   landing page → it does not enter.

## Judgement calls

**Preprint vs. published.** If both exist, ingest the published version and note the preprint date
if priority matters. Never ingest both — that creates two pages for one result.

**Papers with corrections or expressions of concern.** `discover` flags these. Usable, but the
correction must be linked and its effect on the headline number stated in `caveats_md`.

**Industry-sponsored trials.** Ingest normally — sponsorship is not disqualifying. Stage
`01-analysis` records funding and conflicts, and the published page renders them. What matters is
that the registry record backs the claims.

**Non-open-access papers.** Common and important. There is no PDF to parse, so they do not enter
`sources/`. They remain first-class *citations*: the enrich agents can read the abstract and link
the DOI. Record them in your report as "cited, not ingested" so the gap is visible.

**Old papers.** Recency is a small score bump, not a gate. Foundational work (1984 NINCDS-ADRDA
criteria, 1992 amyloid-cascade hypothesis) is tier 1 forever.

**Contradictory sources.** Ingest both. The pipeline's reviewer resolves or flags conflicts; a
knowledge base that only ingests agreeing papers is a marketing site.

## Balance

For any contested drug or hypothesis, a defensible source set includes the trials that failed, not
only the ones that read out well. Before stopping, check: is there a negative or null result on
this topic that was not ingested? If so, either ingest it or state why not.
