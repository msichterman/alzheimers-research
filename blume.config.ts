import { defineConfig } from "blume";
import type { ComponentMarkdown } from "blume";
import { z } from "zod";

/**
 * Canonical origin — the production hostname the Worker is routed to (see
 * `wrangler.jsonc`). Absolute URLs everywhere resolve against it: llms.txt
 * links, the MCP install snippets, the agent-readability manifest, sitemap,
 * OG images. Override with BLUME_SITE for a preview deploy or a fork.
 */
const site = process.env.BLUME_SITE ?? "https://alzheimers.dev";

/**
 * Public key(s) for Web Bot Auth, loaded from the environment so no key blob
 * lives in the repo. Unset means an empty directory, which Blume skips.
 */
const webBotAuthKey = process.env.WEB_BOT_AUTH_PUBLIC_JWK;

/**
 * Agent-facing Markdown for the custom <OpenInChat /> component: agents read
 * the `.md` mirror, where a row of chat buttons is meaningless — the prompt
 * behind it is not. Hand them the prompt text instead.
 */
const openInChat: ComponentMarkdown = ({ children, props }) => {
  const prompt = String(props.prompt ?? children ?? "").trim();
  return prompt ? `**Prompt:**\n\n\`\`\`text\n${prompt}\n\`\`\`` : null;
};

export default defineConfig({
  title: "Alzheimer's Research",
  description:
    "A working knowledge base for Alzheimer's disease research: consolidated paper notes, a clinical trial tracker, and a timeline of the field. Built to be read by agents as well as people.",
  github: { owner: "msichterman", repo: "alzheimers-research" },
  navigation: {
    tabs: [
      { label: "For Families", path: "/journey/newly-diagnosed", icon: "heart" },
      { label: "Research", path: "/research", icon: "book-open" },
      { label: "Trials", path: "/trials", icon: "flask-conical" },
      { label: "Timeline", path: "/timeline", icon: "calendar" },
      { label: "For agents", path: "/agents", icon: "bot" },
    ],
  },
  content: {
    /**
     * Content types make the corpus queryable by kind rather than by keyword:
     * an agent can scope retrieval to trials, papers, or topics, then narrow
     * with `filters` on the facets below. Every custom key is optional so a
     * hand-written page (or one the pipeline wrote before this existed) still
     * builds; the facets simply go unset.
     */
    types: {
      trial: {
        facets: ["status", "phase", "drug"],
        frontmatter: {
          drug: z.string().optional(),
          phase: z.string().optional(),
          status: z
            .enum(["Recruiting", "Active", "Completed", "Terminated"])
            .optional(),
        },
      },
      paper: {
        // `license` and `firstAuthor` facet so an agent can ask for, say, only
        // CC BY sources it may quote at length, or everything by one author.
        //
        // The per-author credits the licences require ride on Blume's built-in
        // `authors` field, which takes `{ name, … }` objects and passes unknown
        // keys through untouched — so `affiliation`, `orcid`, `email`, and
        // `corresponding` (written by pipeline/publish.mjs, extracted per
        // pipeline/prompts/01-analysis.md) survive without being redeclared
        // here, which the schema forbids for built-in fields.
        facets: ["year", "license", "firstAuthor"],
        frontmatter: {
          year: z.string().optional(),
          doi: z.string().optional(),
          license: z.string().optional(),
          firstAuthor: z.string().optional(),
        },
      },
      topic: {
        facets: ["stance"],
        frontmatter: {
          stance: z.enum(["mainstream", "contested", "emerging"]).optional(),
        },
      },
      "consumer-guide": {
        facets: ["stage", "audience"],
        frontmatter: {
          stage: z.string().optional(),
          audience: z.string().optional(),
          url: z.string().optional(),
        },
      },
    },
  },
  ai: {
    /** Machine-readable corpus: a linked index plus the full text, at the root. */
    llmsTxt: { enabled: true, openapi: false },

    /**
     * In-page assistant, grounded in these pages: it answers from the retrieved
     * notes and cites them, rather than from the model's own recall — which
     * matters when the subject is clinical evidence.
     */
    ask: {
      enabled: true,
      provider: "gateway",
      model: "anthropic/claude-sonnet-4-5",
      instructions: [
        "You are the research assistant for an Alzheimer's disease knowledge base.",
        "Answer only from the retrieved pages and cite each one you use as a Markdown link.",
        "Distinguish what a trial or paper actually showed from what its sponsor or press coverage claimed; this corpus records failed and discontinued programs on purpose, so never present a missed endpoint as a success.",
        "Quote effect sizes, endpoints, and dates exactly as the pages state them, and say plainly when the corpus does not cover something.",
        "This is a research reference, not medical advice: do not recommend treatments or interpret anyone's personal medical situation.",
      ].join(" "),
      suggestions: [
        { label: "Which tracked trials are still active?", icon: "flask-conical" },
        { label: "What did the GAIN trial actually show?", icon: "search" },
        {
          label: "Summarize the evidence for and against the amyloid hypothesis.",
          icon: "scale",
        },
        { label: "Which blood biomarkers are trial-ready?", icon: "droplet" },
        { label: "What readouts are expected in 2027?", icon: "calendar" },
      ],
    },

    /**
     * The MCP server turns this repo into a tool a coding agent can call:
     * search_docs, get_page, list_pages, get_navigation — over the same
     * content, with no scraping and no separate index to keep in sync.
     */
    mcp: {
      enabled: true,
      route: "/mcp",
      name: "Alzheimer's Research",
      instructions: [
        "A curated Alzheimer's disease knowledge base: one page per paper (type `paper`), one per clinical trial (type `trial`), synthesis pages per question (type `topic`), and a dated timeline of the field.",
        "Scope retrieval with `contentTypes`, then narrow with `filters`: trials facet on `status`, `phase`, and `drug`; papers on `year`, `license`, and `firstAuthor`; topics on `stance`.",
        "Every paper note carries a Critical review section (funding and conflicts, bias flags, claim-by-claim evidence strength, cross-examination) — read it before repeating a claim, and cite the page you drew from.",
        "Each paper page also carries an Attribution section and frontmatter (`authors`, `firstAuthor`, `doi`, `license`): credit the original authors rather than this site when you repeat a finding, check `license` before quoting at length (`unknown` means reuse terms are unconfirmed — summarize and link instead), and carry any declared conflict along with the claim it affects.",
      ].join(" "),
    },

    /**
     * WebMCP: an agentic browser sitting on any page of this site can search
     * and read the corpus in-page, with no server connection at all.
     */
    webmcp: true,

    /** Publish this project's agent skills for discovery (see `skills/`). */
    skills: "./skills",

    /** Verifiable identity for agents that make requests as this domain. */
    webBotAuth: {
      keys: webBotAuthKey ? [JSON.parse(webBotAuthKey)] : [],
    },

    markdownComponents: { OpenInChat: openInChat },
  },
  seo: {
    /** One fetch tells an agent every machine-readable surface this site has. */
    agentReadability: true,
    /** Open to search, to retrieval at answer time, and to training. */
    contentSignals: { search: true, aiInput: true, aiTrain: true },
  },
  search: {
    // Orama is the default provider: keyless, client-side, works in dev and build.
    popular: [
      { href: "/agents", icon: "bot", label: "Use these docs from your agent" },
      { href: "/timeline", icon: "calendar", label: "Timeline" },
      { href: "/trials", icon: "flask-conical", label: "Trial tracker" },
      { href: "/research", icon: "book-open", label: "Research notes" },
      { href: "/research/papers", icon: "file-text", label: "Papers by date" },
    ],
  },
  deployment: {
    // Ask AI (`POST /api/ask`) and the MCP server (`/mcp`) are live endpoints,
    // so this site builds as a server, not a static folder. One target — a
    // Cloudflare Worker — so the adapter is explicit rather than detected:
    // CI builds the same artifact a local `pnpm build` produces.
    output: "server",
    adapter: "cloudflare",
    site,
  },
  redirects: [
    // Paper notes moved into the /research/papers/ subsection.
    {
      from: "/research/buntanetap-phase-2-3-ad",
      to: "/research/papers/buntanetap-phase-2-3-ad",
    },
    {
      from: "/research/p-gingivalis-cor388-alzheimers",
      to: "/research/papers/p-gingivalis-cor388-alzheimers",
    },
  ],
});
