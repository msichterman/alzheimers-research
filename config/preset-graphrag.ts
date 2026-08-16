import type { BlumeConfig, ComponentMarkdown } from "blume";
import { z } from "zod";

export interface GraphRagPresetOptions {
  /** Canonical domain origin */
  site?: string;
  /** Primary search backend */
  searchProvider?: "orama" | "mixedbread" | "flexsearch" | "typesense" | "algolia";
  /** Mixedbread Store ID if semantic search is active */
  mixedbreadStoreId?: string;
  /** Extra frontmatter facets to append to content types */
  extraFacets?: {
    trial?: string[];
    paper?: string[];
    topic?: string[];
  };
  /** Enable Web Bot Authentication for agent trust */
  webBotAuthKey?: string;
}

/** Recursively extracts text content from React / MDX children with depth bounds */
function extractNodeText(node: any, depth = 0): string {
  if (!node || depth > 50) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => extractNodeText(n, depth + 1)).join("");
  if (typeof node === "object" && node.props?.children) {
    return extractNodeText(node.props.children, depth + 1);
  }
  return "";
}

/** Standard Prompt Bridge for AI Agents reading Markdown mirrors */
export const openInChatRenderer: ComponentMarkdown = ({ children, props }) => {
  const promptText = typeof props?.prompt === "string" ? props.prompt : extractNodeText(children);
  const cleanPrompt = promptText.trim();
  return cleanPrompt ? `**Prompt:**\n\n\`\`\`text\n${cleanPrompt}\n\`\`\`` : null;
};

/** Safe JSON Parser for WebBotAuth JWKS keys */
function parseWebBotAuthKeys(keyStr?: string): any[] {
  if (!keyStr || typeof keyStr !== "string" || !keyStr.trim()) return [];
  const trimmed = keyStr.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        if (Array.isArray(parsed.keys)) return parsed.keys;
        if (Array.isArray(parsed)) return parsed;
        return [parsed];
      }
    } catch (err: any) {
      throw new Error(`Invalid WebBotAuth JWKS JSON in WEB_BOT_AUTH_PUBLIC_JWK: ${err.message}`);
    }
  }
  return [trimmed];
}

/**
 * Reusable GraphRAG Preset for Blume.
 * Configures typed schemas, graph facets, MCP tools, and SEO signals.
 */
export function defineGraphRagPreset(options: GraphRagPresetOptions = {}): Partial<BlumeConfig> {
  const env = typeof process !== "undefined" && process.env ? process.env : {};

  const {
    site = "https://alzheimers.dev",
    searchProvider = "orama",
    mixedbreadStoreId = env.MIXEDBREAD_STORE_ID,
    extraFacets = {},
    webBotAuthKey = env.WEB_BOT_AUTH_PUBLIC_JWK,
  } = options;

  return {
    content: {
      root: "docs",
      types: {
        trial: {
          facets: ["status", "phase", "drug", ...(extraFacets.trial ?? [])],
          frontmatter: {
            drug: z.union([z.string(), z.array(z.string())]).optional(),
            phase: z.coerce.string().optional(),
            status: z.string().optional(),
          },
        },
        paper: {
          facets: ["year", "license", "firstAuthor", ...(extraFacets.paper ?? [])],
          frontmatter: {
            year: z.coerce.string().optional(),
            doi: z.string().optional(),
            license: z.string().optional(),
            firstAuthor: z.string().optional(),
            drug: z.union([z.string(), z.array(z.string())]).optional(),
            trial: z.union([z.string(), z.array(z.string())]).optional(),
            nct: z.union([z.string(), z.array(z.string())]).optional(),
          },
        },
        topic: {
          facets: ["stance", ...(extraFacets.topic ?? [])],
          frontmatter: {
            stance: z.enum(["mainstream", "contested", "emerging"]).optional(),
          },
        },
      },
    },

    search: {
      provider: searchProvider,
      ...(searchProvider === "mixedbread" && mixedbreadStoreId
        ? { mixedbread: { storeId: mixedbreadStoreId } }
        : {}),
      popular: [
        { href: "/agents", icon: "bot", label: "Use these docs from your agent" },
        { href: "/timeline", icon: "calendar", label: "Timeline" },
        { href: "/trials", icon: "flask-conical", label: "Trial tracker" },
        { href: "/research", icon: "book-open", label: "Research notes" },
        { href: "/research/papers", icon: "file-text", label: "Papers by date" },
      ],
      indexing: {
        includeHiddenPages: false,
      },
    },

    ai: {
      llmsTxt: { enabled: true, openapi: false },
      mcp: {
        enabled: true,
        route: "/mcp",
        name: "Alzheimer's Research",
        instructions: [
          "A curated Alzheimer's disease knowledge base: one page per paper (type `paper`), one per clinical trial (type `trial`), synthesis pages per question (type `topic`), and a dated timeline of the field.",
          "Scope retrieval with `contentTypes`, then narrow with `filters`: trials facet on `status`, `phase`, and `drug`; papers on `year`, `license`, and `firstAuthor`; topics on `stance`.",
          "Every paper note carries a Critical review section (funding and conflicts, bias flags, claim-by-claim evidence strength, cross-examination) — read it before repeating a claim, and cite the page you drew from.",
          "Each paper page also carries an Attribution section and frontmatter (`authors`, `firstAuthor`, `doi`, `license`).",
        ].join(" "),
      },
      webmcp: true,
      skills: "./skills",
      webBotAuth: {
        keys: parseWebBotAuthKeys(webBotAuthKey),
      },
      markdownComponents: {
        OpenInChat: openInChatRenderer,
      },
    },

    seo: {
      agentReadability: true,
      contentSignals: { search: true, aiInput: true, aiTrain: true },
      sitemap: true,
      robots: true,
      structuredData: true,
    },

    deployment: {
      output: "server",
      adapter: "cloudflare",
      site,
    },
  };
}
