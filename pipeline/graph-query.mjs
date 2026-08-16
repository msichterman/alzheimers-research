// Graph Query & Traversal Engine: provides fast in-memory multi-hop traversal,
// clinical outcome matrix comparisons, and verbatim claim verification.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RAW_DIR, ROOT, readJson } from "./lib.mjs";

let graphCache = null;
let nodeMapCache = null;

export function loadGraph() {
  if (graphCache) return graphCache;
  const path = join(ROOT, "dist", "graph.json");
  if (!existsSync(path)) return null;
  try {
    const data = readJson(path);
    if (!data || !Array.isArray(data.nodes)) {
      return null;
    }
    graphCache = data;
    nodeMapCache = new Map(graphCache.nodes.map((n) => [n.id, n]));
  } catch (err) {
    console.error(`[error] Failed to load knowledge graph: ${err.message}`);
    return null;
  }
  return graphCache;
}

/** Escapes regular expression special characters to avoid ReDoS / injection */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Precompiled clinical synonyms maps with strict hyphen-aware lookaround boundaries */
const CLINICAL_SYNONYMS = {
  "cdr-sb": ["cdr-sb", "clinical dementia rating", "sum of boxes", "cdr global"],
  "adas-cog": ["adas-cog", "alzheimers disease assessment scale", "adas-cog11", "adas-cog13", "adas-cog14"],
  "aria": ["aria", "aria-e", "aria-h", "amyloid-related imaging abnormalities", "edema", "microhemorrhage"],
  "mmse": ["mmse", "mini-mental state examination"],
  "tau": ["tau", "total tau"],
  "ptau": ["p-tau", "ptau", "p-tau181", "p-tau217", "p-tau231"],
  "amyloid": ["amyloid", "centiloid", "a-beta", "abeta42", "suvr"],
};

const PRECOMPILED_SYNONYMS = Object.entries(CLINICAL_SYNONYMS).map(([key, syns]) => ({
  key,
  keyRegex: new RegExp(`(?<![a-zA-Z0-9\\-])${escapeRegex(key)}(?![a-zA-Z0-9\\-])`, "i"),
  regex: new RegExp(syns.map((s) => `(?<![a-zA-Z0-9\\-])${escapeRegex(s)}(?![a-zA-Z0-9\\-])`).join("|"), "i"),
}));

/** Normalizes text for robust quote matching across OCR/PDF/Markdown formatting */
function normalizeForComparison(text) {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // smart single quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // smart double quotes
    .replace(/[\u2013\u2014\u2212]/g, "-")       // dashes & minus signs
    .replace(/-\r?\n\s*/g, "")                    // line-break hyphenations
    .replace(/[*_~`]/g, "")                       // markdown styling tokens
    .replace(/\s+/g, " ")                         // collapse whitespace
    .trim();
}

/**
 * Traverses relationships around a given node with strictly bounded depth and O(1) node resolution.
 * @param {string} nodeId - Node ID (e.g. 'paper:gosuranemab-tango', 'trial:NCT03887455', 'drug:gosuranemab')
 * @param {object} options - { relation, direction: 'in'|'out'|'both', maxDepth }
 */
export function traverseGraph(nodeId, options = {}) {
  const graph = loadGraph();
  if (!graph) return { error: "Graph not compiled. Run `pnpm build:graph` first." };

  const { relation = null, direction = "both", maxDepth = 1 } = options;
  const visited = new Set();
  const queue = [{ id: nodeId, depth: 0 }];
  const edgesResult = [];
  const edgeSet = new Set();

  visited.add(nodeId);
  let head = 0;

  while (head < queue.length) {
    const { id, depth } = queue[head++];
    if (depth >= maxDepth) continue;

    if (direction === "out" || direction === "both") {
      const outEdges = graph.forwardAdjacency[id] || [];
      for (const edge of outEdges) {
        if (!relation || edge.relation === relation) {
          const edgeKey = edge.key || `${id}|${edge.relation}|${edge.target}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edgesResult.push({ key: edge.key, from: id, to: edge.target, relation: edge.relation, properties: edge.properties });
          }
          if (!visited.has(edge.target) && depth + 1 <= maxDepth) {
            visited.add(edge.target);
            queue.push({ id: edge.target, depth: depth + 1 });
          }
        }
      }
    }

    if (direction === "in" || direction === "both") {
      const inEdges = graph.reverseAdjacency[id] || [];
      for (const edge of inEdges) {
        if (!relation || edge.relation === relation) {
          const edgeKey = edge.key || `${edge.source}|${edge.relation}|${id}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edgesResult.push({ key: edge.key, from: edge.source, to: id, relation: edge.relation, properties: edge.properties });
          }
          if (!visited.has(edge.source) && depth + 1 <= maxDepth) {
            visited.add(edge.source);
            queue.push({ id: edge.source, depth: depth + 1 });
          }
        }
      }
    }
  }

  const nodeMap = nodeMapCache || new Map(graph.nodes.map((n) => [n.id, n]));
  const matchedNodes = Array.from(visited).map((id) => nodeMap.get(id)).filter(Boolean);

  return {
    rootNodeId: nodeId,
    nodes: matchedNodes,
    edges: edgesResult,
    totalVisited: visited.size,
  };
}

/**
 * Compares outcomes across studies matching a measure string, literal, or clinical synonym.
 * Uses index lookup when possible and strictly escapes inputs to prevent ReDoS.
 */
export function queryEvidenceMatrix(measurePattern, options = {}) {
  const graph = loadGraph();
  if (!graph) return { error: "Graph not compiled." };

  const safePatternStr = String(measurePattern || "").trim().slice(0, 100);
  if (!safePatternStr) {
    return { query: measurePattern, count: 0, matrix: [] };
  }

  const { tier = null, met = null, prespecified = null } = options;
  const regex = new RegExp(`(?<![a-zA-Z0-9\\-])${escapeRegex(safePatternStr)}(?![a-zA-Z0-9\\-])`, "i");

  // Find precompiled synonym matchers strictly using boundary checking
  const activeSynonymMatchers = PRECOMPILED_SYNONYMS.filter(
    (item) => item.keyRegex.test(safePatternStr) || item.regex.test(safePatternStr),
  );

  const nodeMap = nodeMapCache || new Map(graph.nodes.map((n) => [n.id, n]));
  const outcomes = [];

  const normTier = tier !== null && tier !== undefined ? String(tier).toLowerCase() : null;
  const normMet = met !== null && met !== undefined ? String(met).toLowerCase() : null;
  const normPrespec = prespecified !== null && prespecified !== undefined ? String(prespecified).toLowerCase() : null;

  // Match target measure nodes first
  const matchingMeasureNodeIds = new Set();
  for (const node of graph.nodes) {
    if (node.type === "OutcomeMeasure" || node.type === "Harm") {
      const name = String(node.name || node.id);
      const isDirectMatch = regex.test(name) || regex.test(node.id);
      const isSynonymMatch = activeSynonymMatchers.some(
        (m) => m.regex.test(name) || m.regex.test(node.id),
      );
      if (isDirectMatch || isSynonymMatch) {
        matchingMeasureNodeIds.add(node.id);
      }
    }
  }

  // If measure nodes matched, retrieve directly from outcomeIndex
  if (matchingMeasureNodeIds.size > 0 && graph.outcomeIndex) {
    for (const nodeId of matchingMeasureNodeIds) {
      const outcomeEdges = graph.outcomeIndex[nodeId] || [];
      for (const edge of outcomeEdges) {
        const props = edge.properties || {};
        if (normTier && String(props.tier || "").toLowerCase() !== normTier) continue;
        if (normMet && String(props.met ?? "").toLowerCase() !== normMet) continue;
        if (normPrespec && String(props.prespecified ?? "").toLowerCase() !== normPrespec) continue;

        const targetNode = nodeMap.get(edge.target);
        outcomes.push({
          sourceDocument: edge.source,
          measure: String(targetNode?.name || edge.target),
          relation: edge.relation,
          tier: props.tier,
          prespecified: props.prespecified,
          met: props.met,
          effectEstimate: props.effect,
          confidenceInterval: props.ci,
          pValue: props.pValue,
          verbatimQuote: props.quote,
          location: props.location,
          polarity: props.polarity || targetNode?.polarity || "unspecified",
        });
      }
    }
  } else {
    // Fallback scan
    for (const edge of graph.edges) {
      if (edge.relation === "MEASURED_OUTCOME" || edge.relation === "OBSERVED_HARM") {
        const targetNode = nodeMap.get(edge.target);
        const targetName = String(targetNode?.name || edge.target);

        const isDirectMatch = regex.test(targetName) || regex.test(edge.target);
        const isSynonymMatch = activeSynonymMatchers.some(
          (m) => m.regex.test(targetName) || m.regex.test(edge.target),
        );

        if (isDirectMatch || isSynonymMatch) {
          const props = edge.properties || {};
          if (normTier && String(props.tier || "").toLowerCase() !== normTier) continue;
          if (normMet && String(props.met ?? "").toLowerCase() !== normMet) continue;
          if (normPrespec && String(props.prespecified ?? "").toLowerCase() !== normPrespec) continue;

          outcomes.push({
            sourceDocument: edge.source,
            measure: targetName,
            relation: edge.relation,
            tier: props.tier,
            prespecified: props.prespecified,
            met: props.met,
            effectEstimate: props.effect,
            confidenceInterval: props.ci,
            pValue: props.pValue,
            verbatimQuote: props.quote,
            location: props.location,
            polarity: props.polarity || targetNode?.polarity || "unspecified",
          });
        }
      }
    }
  }

  return {
    query: measurePattern,
    count: outcomes.length,
    matrix: outcomes,
  };
}

/**
 * Verifies a verbatim quote against the raw primary source markdown.
 * Tolerates markdown styling tokens, whitespace, and punctuation variations.
 */
export function verifyQuoteAgainstSource(docSlug, quote) {
  if (!docSlug || !quote) return { verified: false, reason: "Missing docSlug or quote" };
  const rawPath = join(RAW_DIR, docSlug, "document.md");
  if (!existsSync(rawPath)) {
    return { verified: false, reason: `Raw file not found: raw/${docSlug}/document.md` };
  }

  const rawContent = readFileSync(rawPath, "utf8");
  const cleanQuote = quote.trim();
  
  // 1. Exact raw match
  let index = rawContent.indexOf(cleanQuote);
  if (index !== -1) {
    return {
      docSlug,
      verified: true,
      charOffset: index,
      quoteLength: cleanQuote.length,
      mode: "exact",
    };
  }

  // 2. Normalized full match
  const normRaw = normalizeForComparison(rawContent);
  const normQuote = normalizeForComparison(cleanQuote);
  const normIndex = normRaw.indexOf(normQuote);

  if (normIndex === -1) {
    return {
      docSlug,
      verified: false,
      charOffset: -1,
      mode: "unlocatable",
    };
  }

  // Non-word safe anchor search
  const cleanWords = cleanQuote
    .replace(/[*_~`\.,;:!?()[\]{}"']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let rawAnchorIndex = -1;

  if (cleanWords.length >= 6) {
    for (let windowSize = Math.min(cleanWords.length, 8); windowSize >= 6; windowSize--) {
      const anchorRegex = new RegExp(cleanWords.slice(0, windowSize).map(escapeRegex).join("[^a-zA-Z0-9]{1,20}"), "i");
      const match = rawContent.match(anchorRegex);
      if (match && match.index !== undefined) {
        rawAnchorIndex = match.index;
        break;
      }
    }
  } else if (cleanWords.length > 0) {
    const directRegex = new RegExp(cleanWords.map(escapeRegex).join("[^a-zA-Z0-9]{1,20}"), "i");
    const match = rawContent.match(directRegex);
    if (match && match.index !== undefined) {
      rawAnchorIndex = match.index;
    }
  }

  return {
    docSlug,
    verified: true,
    charOffset: rawAnchorIndex !== -1 ? rawAnchorIndex : 0,
    quoteLength: cleanQuote.length,
    mode: "normalized",
  };
}
