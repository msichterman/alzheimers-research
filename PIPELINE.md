# Research pipeline

Turns source documents (PDFs, Word, EPUB, …) into reviewed knowledge-base pages: paper notes, trial pages, and timeline entries. Everything runs locally; the agent stages use your existing Claude Code auth via headless `claude -p`.

```
"buntanetap" ──discover──▶ discovery/*.json ──ingest──▶ sources/*.pdf ──parse──▶ raw/<id>/document.md
  (a question)   APIs        (screened candidates)                      (originals)   anydoc  (clean markdown)
                                                                                                    │
        docs/ ◀──publish── enriched/<id>/*.json ◀──enrich─────────────────────────────────────────┘
   (Blume site)  renderer     (evidence trail)     4 agents
```

## Quick start

```bash
pnpm discover "<query>"                      # find + screen reputable sources
pnpm ingest <path-or-url> [--name my-slug]   # pull an article into sources/
pnpm research                                # parse -> enrich -> publish, incremental
pnpm dev                                     # preview the site
```

Or hand the whole loop to the `/research` skill (`.agents/skills/research/`), which frames the
question, runs discovery, screens candidates against a source-tier policy, ingests what passes,
runs the pipeline, and reviews the output before reporting.

Everything is incremental against content hashes: re-running `pnpm research` skips what's already done and retries what failed. Nothing is destructive — `publish` overwrites only pipeline-generated pages, and the timeline merge deduplicates by entry title.

## Stages

| Command | What it does |
| --- | --- |
| `pnpm discover "<query>"` | Searches [Europe PMC](https://europepmc.org/RestfulWebService) (PubMed + PMC + preprints) and the [ClinicalTrials.gov v2 API](https://clinicaltrials.gov/data-api/api), scores every hit for reputability, hard-excludes retracted work (via `pubType` and `Retraction in` correction records), flags errata, conference abstracts, and preprints, and marks what is already ingested or already cited. Read-only: it writes `discovery/<query>.json` and prints ready-to-run `pnpm ingest` commands. Trials are reported with `already_documented`, so gaps in the trial tracker surface on their own. |
| `pnpm ingest <path-or-url>` | Copies or downloads an article into `sources/` with a clean slug. |
| `pnpm parse` | Converts every source to GitHub-Flavored Markdown with [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc) → `raw/<id>/document.md` plus a provenance sidecar (`meta.json`: hash, parser version, timestamps). |
| `pnpm enrich` | Runs four research agents per document (below) → `enriched/<id>/*.json`. |
| `pnpm publish:docs` | Deterministically renders the reviewed JSON into `docs/` pages and merges timeline entries in date order. Agents supply content; the renderer owns structure, so pages always match the site templates. Every research page also gets a **Critical review** block rendered straight from the stage outputs — funding & conflicts, bias & spin flags, a claim-by-claim evidence-strength table, and a cross-examination list (fact-check verdicts, registry discrepancies, misinformation flags) — so the pages double as a consistent, machine-derived dataset of who paid, where the spin is, and what survived verification. |
| `pnpm research` | All of the above, in order. Takes optional doc ids: `pnpm research buntanetap-phase-2-3-ad`. |

### The four agents (`pipeline/prompts/`)

1. **`01-analysis` — critic.** Bibliographic metadata (DOI/PubMed verified by web search, never invented), controlled-vocabulary tags, themes, key claims with evidence strength, methods, funding/conflicts, limitations, red flags, and a parse-quality score for the Markdown conversion.
2. **`02-trials` — clinical-trials researcher.** Finds every relevant registered trial, verifies each against its ClinicalTrials.gov record (fetched, not assumed), collects the results record (papers, registry results, FDA actions, company announcements) with dates and links, and — most valuable — lists discrepancies between what the document claims and what the registry shows.
3. **`03-sentiment` — public-sentiment researcher.** Samples Reddit, news, patient/caregiver forums, and investor chatter; reports sentiment per community with example URLs, and a "hype vs. evidence" gap analysis with misinformation flags. Perception, clearly framed as perception.
4. **`04-review` — reviewer/editor.** Cross-checks the other three against the source document, resolves or flags conflicts, then emits the final minimal page content: one research note, trial pages for trials central to the document, milestone-only timeline entries, and notes for a human editor.

Stages 2 and 3 run in parallel after 1; stage 4 runs last. Documents are processed concurrently.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIPELINE_MODEL` | `sonnet` | Model for agent stages (`haiku` cheaper, `opus` deeper). |
| `PIPELINE_MAX_TURNS` | `60` | Max agent turns per stage. |
| `PIPELINE_TIMEOUT_MS` | `900000` | Per-stage timeout (15 min). |
| `PIPELINE_CONCURRENCY` | `2` | Documents enriched at once. |

Useful flags:

```bash
pnpm parse --force                       # reparse even if unchanged
pnpm enrich --stage 02-trials            # re-run one stage (after editing its prompt)
pnpm enrich --force buntanetap-phase-2-3-ad   # redo one document end to end
```

## What's tracked in git

- `discovery/`, `sources/`, `raw/`, `enriched/` are all tracked — they are the evidence trail. `discovery/*.json` records what was found and, just as importantly, what was screened out and why. Every published claim traces back through `enriched/<id>/*.json` to `raw/<id>/document.md` to the original file.
- `enriched/*/logs/` (full agent transcripts + costs) is gitignored.
- Generated pages carry a provenance footer; edit them freely, but republishing the same document overwrites. Durable corrections belong in `enriched/<id>/*.json` (the dataset), not the rendered page.
- Research notes publish to `docs/research/papers/<slug>.mdx` with a `date` and newest-first sidebar order; the papers index table and the trials tracker table are regenerated on every publish. Authoring templates live in `templates/` (out of the site UI).
- **Attribution is generated, not remembered.** Stage 1 extracts one record per author (name, affiliation, ORCID, corresponding-author flag, that author's declared conflicts) plus the copyright line and licence statement; `publish.mjs` renders them into an **Attribution** section on every paper and trial page, writes `authors`/`firstAuthor`/`doi`/`license` into frontmatter, and regenerates `docs/research/authors.mdx`. Contact details are taken **only** from what the source document publishes — never a web lookup for a person — and an unstated licence records as `unknown` rather than assumed open. See [ATTRIBUTION.md](ATTRIBUTION.md).
- Published pages carry the **typed frontmatter contract** that makes the corpus agent-retrievable: `type: paper` with a `year` facet, `type: trial` with `status`, `phase`, and `drug`. Facets are emitted only when the value fits the schema declared in `blume.config.ts` (`content.types`) — a status outside the four allowed values is left off rather than failing the build. Hand-written pages should match; see `templates/`.
- `pnpm check` = `blume doctor` + `pnpm check:links` (every internal link and redirect must resolve).

## Failure modes

- **Image-only/scanned PDF** → anydoc fails with code `unsupported` (it does not OCR). Options: run OCR first (e.g. `ocrmypdf`), or use the hosted [Firecrawl Parse](https://firecrawl.dev/parse) API, which adds OCR models.
- **Encrypted PDF** → `encrypted`; decrypt and re-ingest.
- **Agent returns malformed JSON** → one automatic retry per stage; after that the stage fails and `pnpm research` can be re-run (completed stages are cached).
- **Timeline section without a `<Steps>` block** → the entry is reported for manual placement instead of guessing.

## Cost

Each document runs 4 agent sessions (~$0.20–$1.50 total per document on sonnet, dominated by the web-research stages). `enriched/<id>/state.json` records per-stage cost, and `pnpm enrich` prints the total.

---

## MVP scope (what this is, deliberately)

- One-shot per document; no scheduled refresh.
- Agents are prompt-files run through `claude -p` — no framework, no server, easy to read and edit.
- Human review happens in git: run the pipeline, read the diff, amend, commit.
- The reviewer minimizes clutter but does not merge knowledge *across* documents beyond linking.

## Where a better pipeline goes next

Roughly in order of value:

1. **Registry sync for the trial tracker.** `discover` already reads the registry and flags NCT ids with no page; the missing half is the diff. A nightly job hits the ClinicalTrials.gov API v2 for every NCT id in `docs/trials/`, diffs status/enrollment/dates against the page, appends dated status-log entries, and proposes timeline milestones. The trials section then maintains itself; papers become annotations on a live registry spine.
2. **Watchers instead of manual ingest.** `discover` covers the search half. What's missing is the schedule and the automatic gate: saved queries run nightly, a relevance-gate agent decides what's worth parsing, and qualifying papers land in `sources/` without a human typing the query. Plus bioRxiv/medRxiv feeds, journal RSS, and Zotero import for the existing library.
3. **Claim graph + contradiction detection.** Stage 1 already extracts claims; store them in one queryable index (claim, direction, effect size, population, source) so a new paper's claims are automatically checked against every prior paper's, and topic pages (e.g. the amyloid hypothesis page) update from the graph instead of by hand.
4. **Verification hardening.** A link-checker that fetches every published URL and confirms the cited fact appears there; N independent "refuter" agents voting on each fact the reviewer wants to publish (adversarial verification); numeric consistency checks between page, raw markdown, and registry.
5. **Entity resolution.** One canonical page per drug/target with alias handling (buntanetap = posiphen = ANVS401), so five papers about one drug enrich a single page rather than creating five.
6. **PR-based publishing.** Each document produces a branch + PR with the full diff and the reviewer's notes as the PR description — human approval becomes a merge, and the knowledge base's main branch is always reviewed.
7. **Scheduled sentiment snapshots.** Weekly sentiment runs appended as dated entries make hype measurable over time (interesting around readouts and approvals).
8. **Cost/quality tiering.** Haiku for extraction, Sonnet for research, Opus for the final review; or move the orchestration to the Claude Agent SDK for parallel tool-calling agents, retries, and structured outputs without the CLI hop.
9. **OCR fallback** wired into `parse` (local `ocrmypdf`, or hosted Firecrawl Parse) so scanned PDFs flow through the same path.
10. **Embedding search over `raw/`** for cross-paper questions the site search can't answer ("every effect size reported for ADAS-Cog11 in mild AD").
