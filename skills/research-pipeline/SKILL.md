---
name: research-pipeline
description: Add a paper, trial, or timeline entry to the Alzheimer's Research knowledge base using its local research pipeline — discover and screen sources, ingest, parse to Markdown, run the four review agents, and publish template-conformant pages with a full evidence trail. Use when extending the corpus rather than querying it.
---

# Research pipeline

Turns a source document into reviewed knowledge-base pages. Everything runs locally; agent stages go through headless `claude -p`. Every stage is incremental against content hashes, so re-running skips what's done and retries what failed.

```
"buntanetap" ──discover──▶ discovery/*.json ──ingest──▶ sources/*.pdf ──parse──▶ raw/<id>/document.md
        docs/ ◀──publish── enriched/<id>/*.json ◀──enrich── 4 agents ◀──────────────┘
```

## The loop

```bash
pnpm discover "<query>"                      # find + screen reputable sources
pnpm ingest <path-or-url> [--name my-slug]   # pull an article into sources/
pnpm research                                # parse -> enrich -> publish
pnpm check                                   # blume doctor + internal link check
```

`pnpm discover` searches Europe PMC and the ClinicalTrials.gov v2 API, scores each hit for reputability, hard-excludes retracted work, and flags errata, conference abstracts, and preprints. It is read-only: it writes `discovery/<query>.json` and prints the `pnpm ingest` commands to run. Screen candidates against the source-tier policy before ingesting anything.

## The four agents (`pipeline/prompts/`)

1. **`01-analysis` — critic.** Metadata (DOI/PubMed verified by search, never invented), tags, themes, key claims with evidence strength, methods, funding and conflicts, limitations, red flags.
2. **`02-trials` — clinical-trials researcher.** Verifies every referenced trial against its registry record and lists discrepancies between what the document claims and what the registry shows.
3. **`03-sentiment` — public-sentiment researcher.** Community sentiment with example URLs and a hype-vs-evidence gap analysis. Perception, framed as perception.
4. **`04-review` — reviewer/editor.** Cross-checks the other three against the source and emits the final page content.

Agents supply content; `pipeline/publish.mjs` owns structure, so published pages always match the templates.

## Frontmatter contract

Pages are typed and faceted so agents can retrieve them by kind. Keep this contract when writing pages by hand:

```yaml
# docs/trials/<slug>.mdx
type: trial
status: Active # Recruiting | Active | Completed | Terminated
phase: "3"
drug: Lecanemab
sidebar:
  badge: Active
search:
  tags: [trial, lecanemab]
```

```yaml
# docs/research/papers/<slug>.mdx
type: paper
date: 2026-04-01
year: "2026"
search:
  tags: [paper, buntanetap]
```

Topic pages use `type: topic` with `stance: mainstream | contested | emerging`. Templates live in `templates/`.

## Rules

- **Never invent a citation.** DOIs, PubMed IDs, and NCT numbers are verified against the real record or left out.
- **Record failures.** Missed endpoints, clinical holds, and discontinued programs are the point of the corpus, not an omission.
- **Durable corrections belong in `enriched/<id>/*.json`**, the dataset — not in the rendered page, which republishing overwrites.
- **Keep the evidence trail.** `discovery/`, `sources/`, `raw/`, and `enriched/` are tracked in git so every published claim traces back to the original file.
- **Milestones go on the timeline** in date order, linked to the page that backs them.

Full documentation: `PIPELINE.md` in the repo. To query the corpus rather than extend it, use the `alzheimers-research` skill.
