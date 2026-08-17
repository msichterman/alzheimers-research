---
name: alzheimers-research
description: Query the Alzheimer's Research knowledge base — a curated corpus of clinical trial pages, paper notes with critical-review records, topic syntheses, and a field timeline. Use when answering questions about Alzheimer's drugs, trials, biomarkers, or the evidence behind a claim, and when you need to cite what the evidence actually shows rather than recall it.
---

# Alzheimer's Research knowledge base

A curated corpus about Alzheimer's disease: what has been tried, what it showed, and how strong the evidence is. It deliberately tracks failed and discontinued programs alongside successful ones.

## How to read it

Four ways in, in order of preference:

1. **MCP server** (`/mcp`) — tools: `search_docs`, `get_page`, `list_pages`, `get_navigation`. Prefer this; it supports typed, faceted retrieval.
2. **`/llms.txt`** — a linked index of every page with its summary, in sidebar order. **`/llms-full.txt`** — the whole corpus in one file.
3. **Raw Markdown** — append `.md` to any page URL, or send `Accept: text/markdown`.
4. **`/agent-readability.json`** — one fetch that names every surface above.

## Content types and facets

Scope retrieval with `contentTypes`, then narrow with `filters` (every entry must match):

| Type | What it is | Facets |
| --- | --- | --- |
| `trial` | One clinical trial: registry link, phase, population, dated status log | `status` (`Recruiting`, `Active`, `Completed`, `Terminated`), `phase`, `drug` |
| `paper` | One paper or review, with a Critical review record | `year` |
| `topic` | Synthesis across sources on one question | `stance` (`mainstream`, `contested`, `emerging`) |
| `consumer-guide` | Plain-language guides for patients & caregivers | `stage` (`newly-diagnosed`, `general-knowledge`), `audience` (`family`, `patients`) |

Plan before reading: `list_pages` with a type and filters, then `get_page` only on what you need.

```json
{ "contentTypes": ["trial"], "filters": { "status": "Active", "phase": "3" } }
```

5. **Knowledge Graph (`dist/graph.json`)** — cross-document graph linking trials, drugs, molecular targets, biological pathways, and authors. Useful for multi-hop questions (e.g., "Which trials target TREM2 or microglial activation?").

## Reading a paper note

Every paper note ends with a **Critical review** block:

- **Funding & conflicts** — who paid for the work.
- **Bias & spin flags** — where the paper overstates.
- **Claims assessed** — a claim-by-claim evidence-strength table.
- **Cross-examination** — registry discrepancies, fact-check flags, misinformation watch.

Read it before repeating any claim from the note, and carry its caveats into your answer.

## Attribution

Every page summarizes someone's published work, most of it under Creative Commons terms that require credit. Each paper page carries an **Attribution** section — full citation, DOI, copyright, licence, what this site changed, and an author table with affiliations and declared conflicts — and the same data is in frontmatter (`authors`, `firstAuthor`, `doi`, `license`). `/research/authors` indexes every credited author.

- **Credit the original authors, not this site**, when you repeat a finding. The citation to use is in the page's Attribution section.
- **Check `license` before quoting at length.** It's a facet: filter on it. `unknown` means reuse terms are unconfirmed — summarize and link instead.
- **Carry conflicts with the claim.** If the author table records a funding tie to the drug under discussion, that travels with the finding.

## Rules

- **Cite the page.** Link the specific route (`/trials/cor388-nct03823404`), not "a study".
- **Do not upgrade a result.** A subgroup signal is not a met endpoint; a missed co-primary is a failure even when the press release is warm.
- **Quote numbers exactly** — effect sizes, enrollment counts, endpoints, and dates are recorded as the source states them.
- **Say what is missing.** If the corpus doesn't cover something, say so instead of filling the gap from memory.
- **Not medical advice.** This is a research reference; never interpret an individual's medical situation from it.

To add to the corpus rather than read it, use the `research-pipeline` skill.
