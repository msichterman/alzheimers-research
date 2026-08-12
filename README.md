# Alzheimer's Research

A working knowledge base for Alzheimer's disease research, built with [Blume](https://github.com/haydenbleasel/blume): consolidated paper notes, a clinical trial tracker, and a timeline of the field.

It is **AI-native**: every page has a Markdown twin, the whole corpus is one fetch, and the site hosts its own MCP server so a coding agent can search and read it directly. Connect it with:

```bash
claude mcp add --transport http alzheimers-research https://alzheimers.dev/mcp
```

See [`docs/agents/`](docs/agents/index.mdx) — or the **For agents** tab on the site — for every agent-facing surface.

New papers flow in through a local [research pipeline](PIPELINE.md): drop a PDF in, and `pnpm research` parses it to clean Markdown ([anydoc](https://github.com/firecrawl/anydoc)), runs four Claude research agents over it (critic, clinical-trials researcher, public-sentiment scan, fact-checking reviewer), and publishes template-conformant pages with a full evidence trail.

Finding the papers is part of the pipeline too: `pnpm discover` searches Europe PMC and ClinicalTrials.gov, scores each hit for reputability, and excludes retracted work before anything is ingested.

```bash
pnpm discover "<query>"     # find and screen reputable sources
pnpm ingest <path-or-url>   # add an article to sources/
pnpm research               # parse -> enrich -> publish (incremental)
```

Or run the whole loop with the `/research` skill, which frames the question, screens candidates against a [source-tier policy](.agents/skills/research/references/source-tiers.md), ingests what passes, and reviews the output before reporting.

## Attribution and licensing

This knowledge base summarizes other people's published research, most of it under Creative Commons licences that require credit, a licence link, and a statement of what changed — so the pipeline generates all three onto every page rather than leaving it to prose. Each paper page has an **Attribution** section (citation, DOI, copyright, licence, changes made, and an author table with affiliations, contact, and declared conflicts); [`docs/research/authors.mdx`](docs/research/authors.mdx) indexes every credited author; and the site footer carries the notice on every page.

Contact details come only from what a source document itself publishes — never a web lookup for a person. Corrections: open an issue, or edit `enriched/<id>/01-analysis.json` and re-publish.

| Layer | Licence |
| --- | --- |
| Site code, pipeline, components | [MIT](LICENSE) |
| Summaries, notes, and commentary in `docs/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Source documents and their parsed text | Each source's own licence — see [`sources/README.md`](sources/README.md) |
| Trial registry data | US government work, via ClinicalTrials.gov |

Full third-party credits — frameworks, tooling, icons, brand marks — are in [ATTRIBUTION.md](ATTRIBUTION.md).

## Structure

- `docs/research/` — topic pages that synthesize across sources (`type: topic`), plus `docs/research/papers/`: one dated note per paper (`type: paper`), sorted newest first, each with a critical-review record (funding, bias flags, claim strength, cross-examination).
- `docs/trials/` — one page per clinical trial (`type: trial`): registry link, phase, population, dated status log. The tracker table is auto-generated from the pages.
- `docs/timeline/` — discoveries, approvals, and trial milestones in chronological order, linked back to the pages that back them.
- `docs/agents/` — how to consume this corpus from an agent, and every machine-readable surface it publishes.
- `templates/` — copy-paste templates for hand-written paper notes and trial pages (kept out of the site UI).
- `skills/` — agent skills published at `/.well-known/agent-skills/`: one for querying the corpus, one for extending it.
- `components/` — site components (`OpenInChat.astro`, the attribution `Footer.astro`), registered in `components.ts`.
- `discovery/` → `sources/` → `raw/` → `enriched/` — pipeline artifacts: original documents, parsed Markdown, and per-stage agent outputs (the provenance trail). See [PIPELINE.md](PIPELINE.md).

Pages are **typed and faceted**, so an agent can retrieve a slice rather than the whole corpus: trials facet on `status`, `phase`, and `drug`; papers on `year`, `license`, and `firstAuthor`; topics on `stance`. The types are declared in `blume.config.ts` under `content.types`, and the facets ride along on both the search index and the MCP index.

## Develop

```bash
pnpm install
pnpm dev            # dev server with hot reload, live search, and the MCP endpoint
pnpm build          # Cloudflare Worker build (Ask AI and /mcp are live routes)
pnpm preview        # run the built Worker locally: wrangler dev
pnpm check          # blume doctor + internal link check
pnpm audit:agents   # SEO/agent-readability audit, incl. the DNS-AID record
pnpm eval           # answer questions using only these docs, and grade the answers
```

Search is client-side (Orama) with no keys or hosted service — press ⌘K in the site.

### Deployment

Production is **[alzheimers.dev](https://alzheimers.dev) on Cloudflare Workers**. Ask AI (`POST /api/ask`) and the MCP server (`/mcp`) are request-time routes, so the build is a server build with the Cloudflare adapter (pinned in `blume.config.ts`); `wrangler.jsonc` holds the Worker config, which the build merges into `dist/server/wrangler.json` — the file every deploy command points at.

- **CI/CD** — pushes to `main` deploy production via `.github/workflows/deploy.yml` (gated on checks, with a post-deploy smoke test of the agent surfaces); PRs get preview versions from `ci.yml`. Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and optionally `AI_GATEWAY_API_KEY` + `WEB_BOT_AUTH_PUBLIC_JWK`. The API token needs **Workers Scripts:Edit**, **Workers Routes:Edit**, and **DNS:Edit** on the `alzheimers.dev` zone.
- **From a laptop** — `pnpm cf login` once (see below), then `pnpm deploy:site` (build + deploy) or `pnpm deploy:dry` to validate the Worker bundle without shipping. `pnpm run deploy` deploys an existing build — `pnpm run`, because pnpm's built-in `deploy` command shadows the script. The first deploy attaches the `alzheimers.dev` custom domain and creates its DNS record; the zone must already be in the Cloudflare account.
- **Ask AI key** — `pnpm cf secret put AI_GATEWAY_API_KEY --config dist/server/wrangler.json` (CI syncs it automatically when the GitHub secret exists).

#### One Cloudflare account per repo

Wrangler stores its OAuth session in a single machine-global file, so `wrangler login` in any project silently repoints every other project at the new account. Every wrangler command here goes through **`scripts/cf`** instead, which points wrangler's config home at `.cloudflare/` inside this repo — sign in here and nothing else on the machine changes:

```bash
pnpm cf login      # sign in — this repo only
pnpm cf whoami     # which account this repo deploys to
pnpm cf logout     # sign out — this repo only
pnpm cf <anything> # any wrangler command, scoped the same way
```

Then pin the account so a deploy can't drift into the wrong one:

```bash
cp .env.cloudflare.example .env.cloudflare   # gitignored
# set CLOUDFLARE_ACCOUNT_ID to the id `pnpm cf whoami` printed
```

Wrangler's browser login **cannot grant DNS write** — `dns_records:write` isn't in its OAuth scope list — so attaching a custom domain over pre-existing records needs a **User API Token** (Create Token → Custom token; Account → Workers Scripts:Edit, Zone → Workers Routes:Edit, Zone → DNS:Edit, scoped to the `alzheimers.dev` zone). Put it in `.env.cloudflare` as `CLOUDFLARE_API_TOKEN`. It's 40 characters with no prefix; note that a token set there outranks the login session, so a wrong value breaks every `pnpm cf` command until you comment it out.

This must be the account that owns the `alzheimers.dev` zone — `custom_domain` in `wrangler.jsonc` fails with *"Could not find zone"* otherwise. Setting `CLOUDFLARE_API_TOKEN` in the same file skips the browser sign-in entirely (headless machines, or a token scoped to just this project). CI needs neither: the `CLOUDFLARE_API_TOKEN` environment variable takes precedence over any stored session, so the workflows and your laptop run the same commands.

Copy `.env.example` to `.env.local` for local development:

| Variable | Needed for |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Ask AI (Vercel AI Gateway key) |
| `BLUME_SITE` | Overriding the canonical origin (defaults to `https://alzheimers.dev`) |
| `WEB_BOT_AUTH_PUBLIC_JWK` | Publishing the Web Bot Auth signature directory (optional) |

One agent-facing surface can't ship in a build — DNS-based discovery lives in the zone. In the `alzheimers.dev` DNS settings, publish:

```txt
_index._agents.alzheimers.dev. 3600 IN HTTPS 1 alzheimers.dev. alpn=h2
```

`pnpm audit:agents --url https://alzheimers.dev` checks it (the deploy workflow runs this after every production deploy, non-blocking).
