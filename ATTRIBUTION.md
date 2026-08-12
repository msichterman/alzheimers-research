# Attribution

This project summarizes published research and stands on other people's software. Everything it borrows is credited here; everything it publishes is credited on the page that publishes it.

The site-facing version of this page is [alzheimers.dev/attribution](https://alzheimers.dev/attribution).

## Licensing

| Layer | Licence |
| --- | --- |
| Site code, pipeline, components (`pipeline/`, `components/`, `blume.config.ts`, `scripts/`) | [MIT](LICENSE) |
| Summaries, notes, timeline, and commentary in `docs/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Source documents in `sources/` and their parsed text in `raw/` | Each source's own licence — see below |
| Trial registry data | US government work, via [ClinicalTrials.gov](https://clinicaltrials.gov) |

## Research sources

Every paper page carries its own **Attribution** section (citation, DOI, copyright, licence, changes made, and an author table with affiliations, contact, and declared conflicts). The machine-readable record lives in `enriched/<id>/01-analysis.json`, and the roll-up of everyone credited is at [`docs/research/authors.mdx`](docs/research/authors.mdx).

| Source | Authors | Venue | Licence |
| --- | --- | --- | --- |
| [Porphyromonas gingivalis and Alzheimer disease: Recent findings and potential therapies](https://doi.org/10.1002/JPER.20-0104) | Ryder M.I. (UCSF) | *Journal of Periodontology*, 2020 | CC BY — "This is an open access article under the terms of the Creative Commons Attribution License" |
| [Buntanetap treatment in mild to moderate Alzheimer's disease: phase 2/3 study](https://doi.org/10.1038/s44400-026-00073-z) | Fang C. et al. (Annovis Bio and co-authors) | *npj Dementia*, 2026 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Both permit redistribution with attribution, which is why the original PDFs (`sources/`) and their parsed text (`raw/`) are kept in the repository as the provenance trail. A source whose licence can't be confirmed is recorded as `unknown` and is summarized and linked rather than reproduced.

## Data services

- **[ClinicalTrials.gov](https://clinicaltrials.gov)** (US National Library of Medicine) — trial registry records behind every page in `docs/trials/`, queried through the [v2 API](https://clinicaltrials.gov/data-api/api).
- **[Europe PMC](https://europepmc.org)** — literature search and screening in `pnpm discover`, including retraction and correction records.

## Software

| Project | Used for | Licence |
| --- | --- | --- |
| [Blume](https://github.com/haydenbleasel/blume) — Hayden Bleasel | The documentation framework: site, search, MCP server, `llms.txt`, Markdown mirrors | MIT |
| [Astro](https://astro.build) and [Vite](https://vite.dev) | The runtime Blume builds on | MIT |
| [anydoc](https://github.com/firecrawl/anydoc) — Firecrawl | PDF → Markdown parsing in `pnpm parse` | MIT |
| [Cloudflare Workers](https://workers.cloudflare.com), [`@astrojs/cloudflare`](https://github.com/withastro/astro), [Wrangler](https://github.com/cloudflare/workers-sdk) | Hosting and deployment | Apache-2.0 / MIT |
| [Zod](https://zod.dev) | Frontmatter and config schemas | MIT |
| [Orama](https://askorama.ai) | Client-side search | Apache-2.0 |
| [Lucide](https://lucide.dev) | Icons throughout the site | ISC |
| [Model Context Protocol](https://modelcontextprotocol.io) | The agent tool interface at `/mcp` | MIT |
| [Claude Code](https://claude.com/claude-code) | The agent runtime behind the four pipeline stages | Anthropic terms |

### Components

- **`components/OpenInChat.astro`** is modeled on [AI Elements' `OpenIn` component](https://elements.ai-sdk.dev/components/open-in-chat) (Vercel) — the interaction and provider set are theirs; the Astro implementation is this project's. The provider URL patterns and monochrome brand marks follow [Blume's own page-action menu](https://github.com/haydenbleasel/blume) (MIT).
- Brand marks for ChatGPT, Claude, Cursor, T3 Chat, Scira, v0, and Codex are trademarks of their respective owners, used only to identify the service each link opens.

## Agent skills

The skills published at `/.well-known/agent-skills/` (`skills/`) are this project's own work, under the repository's MIT licence. Third-party skills used during development are installed from their upstream repositories and recorded in `skills-lock.json` rather than vendored here — see [`cloudflare/skills`](https://github.com/cloudflare/skills) and [`haydenbleasel/blume`](https://github.com/haydenbleasel/blume).

## Corrections

If you are credited here or on any page and want the entry corrected or removed, open an issue on [the repository](https://github.com/msichterman/alzheimers-research/issues). Attribution records live in `enriched/<id>/01-analysis.json`; a correction there propagates to every page on the next `pnpm publish:docs`.
