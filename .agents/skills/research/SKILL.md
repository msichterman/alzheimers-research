---
name: research
description: Research an Alzheimer's topic, drug, trial, or paper and turn reputable sources into knowledge-base pages. Finds and screens literature (Europe PMC) and registered trials (ClinicalTrials.gov), ingests what passes the source-tier policy, runs the parse/enrich/publish pipeline, and reviews the result. Use for "/research <topic>", "research this paper", "add <drug> to the knowledge base", "what does the evidence say about X", or when handed a paper URL or PDF.
version: 1
---

# Research

Turn a question into reviewed pages in `docs/`, with every claim traceable to a screened source.

```
question ─▶ discover ─▶ screen ─▶ ingest ─▶ pipeline ─▶ review ─▶ gap check ─┐
            (APIs)     (policy)   (PDFs)   (4 agents)   (you)       └── repeat or stop
```

The pipeline is deterministic and already exists (`PIPELINE.md`). This skill owns the two ends
it does not: **choosing which sources deserve to enter**, and **checking what came out**.

## Invocation

| Input | Do this |
| --- | --- |
| `/research <topic or question>` | Full loop below, starting at Frame. |
| `/research <url or path>` | Skip to Ingest — screen it first, and say so if it fails the policy. |
| `/research` (no args) | Run Pipeline + Review on whatever is already in `sources/`. |

## The loop

Run at most **3 rounds**. Each round:

### 1. Frame (round 1 only)

Write `discovery/<topic-slug>.plan.md`:

- The question in one sentence.
- 2–5 **non-overlapping** subquestions. Fewer is better — one comprehensive line beats three narrow ones.
- What would change the answer (a trial readout, a replication, a retraction).
- Stop condition: which subquestions must be covered to call it done.

Simple fact-finding gets 1–2 subquestions; a drug or hypothesis review gets 3–5. Do not decompose
"research X" into "X overview / X mechanism / X trials" — that is one subject.

### 2. Discover

One `pnpm discover` call per subquestion, **max 5 per round**:

```bash
pnpm discover "buntanetap alzheimer phase 3" --limit 15 --since 2018
```

It queries Europe PMC and ClinicalTrials.gov, scores every hit, hard-excludes retracted work, and
writes `discovery/<query-slug>.json`. Read that file — it carries the reasons behind each score.
Query syntax, flags, and the manual `WebSearch`/`WebFetch` fallback: `references/discovery.md`.

### 3. Screen

Apply `references/source-tiers.md` to the candidates. Non-negotiable:

- **Never ingest** anything the report marks `excluded`, or anything failing a hard exclusion in the policy.
- **Never ingest a press release, investor deck, or news article as evidence.** Follow it to the paper or the registry record.
- Prefer `recommended` with an open-access PDF. `consider` items (conference abstracts, preprints)
  need a stated reason and must carry their caveat into the page.
- A source with no OA PDF cannot be parsed. Do not ingest it — it stays a citation the enrich agents can link.

Ingest **at most 5 documents per round**. Say in your report what you screened out and why.

### 4. Ingest

One call per source, always with an explicit topical slug — it is the doc id everywhere downstream:

```bash
pnpm ingest "https://europepmc.org/articles/PMC12467374?pdf=render" --name buntanetap-crystalline-pk
```

Good slugs read like page names (`buntanetap-phase-2-3-ad`), not like truncated titles.
Skip anything the report marks `already_ingested`.

### 5. Pipeline

```bash
pnpm research            # parse -> enrich -> publish, incremental
```

Four agents run per document (analysis, trials, sentiment, review) and the publisher renders
`docs/`. Roughly $0.20–$1.50 per document. Never hand-write a pipeline-generated page — the
publisher owns page structure and will overwrite it. Fix prompts, not output.

### 6. Review

Do not report success off exit code 0. Work through `references/review-loop.md`: the reviewer's
`notes_for_editor`, every `fact_check` entry that is not `verified`, registry `discrepancies`, and
the `git diff` of `docs/`. Fix what is fixable, surface the rest.

### 7. Gap check, then stop

Stop when any of these is true, and say which:

- Every subquestion in the plan is covered.
- Two consecutive rounds added no new qualifying source.
- Three rounds are done.

Otherwise start a round: new NCT ids and DOIs surfaced by stage `02-trials`, and unresolved
`notes_for_editor`, are the next round's queries.

**Always report what was left out** — non-OA papers, excluded sources, undocumented trials.
Silent truncation reads as complete coverage.

## Rules

- **Sources over recall.** A screened-out source is a result. Ten weak papers are worse than two strong ones.
- **Never invent** a DOI, PMID, NCT id, or URL. Every identifier comes from an API response or a page actually fetched.
- **Registry over press release** for trial facts, always.
- **Preprints and conference abstracts are labelled as such** wherever they appear.
- **Retracted work is never cited as evidence.** It may be discussed *as* a retraction, with the notice linked.
- Do not commit or push unless asked. Review happens in the diff.
- Do not re-run `pnpm enrich` expecting new output without `--force` or `--stage` — completed stages are cached.

## Files

| Path | What it is |
| --- | --- |
| `discovery/<query>.json` | Screened candidates + scores + reasons (tracked evidence trail). |
| `sources/` → `raw/` → `enriched/` → `docs/` | The pipeline chain. See `PIPELINE.md`. |
| `enriched/<id>/04-review.json` | The reviewer's fact-check and editor notes — read this every time. |

## References

- `references/source-tiers.md` — what counts as reputable, hard exclusions, how to handle preprints, press releases, and retractions.
- `references/discovery.md` — `pnpm discover` flags, Europe PMC and ClinicalTrials.gov query syntax, manual search fallback.
- `references/review-loop.md` — the post-pipeline checklist and how to act on each failure mode.
