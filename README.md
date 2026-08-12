# Alzheimer's Research

A working knowledge base for Alzheimer's disease research, built with [Blume](https://github.com/haydenbleasel/blume): consolidated paper notes, a clinical trial tracker, and a timeline of the field.

## Structure

- `docs/research/` — one page per paper or topic, tagged for search. Topic pages synthesize across sources.
- `docs/trials/` — one page per clinical trial: registry link, phase, population, dated status log.
- `docs/timeline/` — discoveries, approvals, and trial milestones in chronological order, linked back to the pages that back them.
- `docs/research/templates/` — copy-paste templates for paper notes and trial pages.

## Develop

```bash
pnpm install
pnpm dev      # dev server with hot reload and live search
pnpm build    # static site to dist/ with a local search index
pnpm doctor   # diagnose config and content problems
```

Search is client-side (Orama) with no keys or hosted service — press ⌘K in the site. Pages are also AI-readable: the built site emits `llms.txt` and serves any page's raw Markdown by appending `.md` to its URL.
