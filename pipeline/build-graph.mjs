#!/usr/bin/env node
// Static Graph Compiler: builds the in-memory knowledge graph from validated
// records, trial registries, and MDX documentation.
//
// Outputs: dist/graph.json
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "yaml";
import { DOCS_DIR, ENRICHED_DIR, RAW_DIR, ROOT, ensureDir, log, readJson, slugify } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const PAPERS_DIR = join(DOCS_DIR, "research", "papers");
const TRIALS_DIR = join(DOCS_DIR, "trials");
const TOPICS_DIR = join(DOCS_DIR, "research");

/** Robust YAML frontmatter parser handling UTF-8 BOM, LF, and CRLF endings */
function extractFrontmatter(content, sourcePath = "") {
  if (!content) return {};
  const clean = content.replace(/^\uFEFF/, "").trimStart();
  if (!clean.startsWith("---")) return {};

  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    if (sourcePath) {
      console.warn(`[warn] Malformed frontmatter (missing closing ---) in ${sourcePath}`);
    }
    return {};
  }

  const yamlText = match[1].trim();
  try {
    const parsed = yaml.parse(yamlText);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (sourcePath) {
      console.warn(`[warn] Failed to parse YAML frontmatter in ${sourcePath}: ${err.message}`);
    }
    return {};
  }
}

/** Clean drug / intervention names by splitting compound strings and stripping prefixes */
function cleanDrugNames(rawIntervention) {
  if (!rawIntervention) return [];
  const rawList = Array.isArray(rawIntervention) ? rawIntervention : [rawIntervention];
  const cleaned = [];

  for (const item of rawList) {
    if (!item || typeof item !== "string") continue;
    // Split on |, ;, or ' and ' for combination therapies
    const subParts = item.split(/[|;]|\sand\s/i);
    for (const part of subParts) {
      const str = part
        .replace(
          /^(drug|biological|behavioral|oral|intravenous|subcutaneous|device|dietary supplement|genetic|radiation|procedure|diagnostic test):\s*/i,
          "",
        )
        .replace(/\bplacebo\b/i, "")
        .trim();
      if (str && str.length > 1) cleaned.push(str);
    }
  }
  return cleaned;
}

/** Deterministic circular-safe serialization with sorted keys and ancestor tracking */
function sortedStringify(obj, ancestors = new Set()) {
  if (!obj || typeof obj !== "object") return JSON.stringify(obj);
  if (ancestors.has(obj)) return '"[Circular]"';

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => sortedStringify(item, ancestors)).join(",")}]`;
    }
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedStringify(obj[k], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(obj);
  }
}

export function compileKnowledgeGraph() {
  const nodes = new Map();
  const edges = [];
  const edgeIndex = new Set();
  const outcomeIndex = Object.create(null);

  function addNode(id, type, properties = {}) {
    if (!id) return;
    const cleanId = String(id).trim();
    if (!nodes.has(cleanId)) {
      nodes.set(cleanId, { id: cleanId, type, ...properties });
    } else {
      const existing = nodes.get(cleanId);
      nodes.set(cleanId, { ...existing, type: type || existing.type, ...properties });
    }
  }

  function addEdge(source, target, relation, properties = {}) {
    if (!source || !target || !relation) return;
    const s = String(source).trim();
    const t = String(target).trim();
    const propsString = sortedStringify(properties || {}) || "{}";
    const propHash = createHash("sha256").update(propsString).digest("hex").slice(0, 16);
    const key = `${s}|${relation}|${t}|${propHash}`;
    if (edgeIndex.has(key)) return;
    edgeIndex.add(key);
    const edgeObj = { key, source: s, target: t, relation, properties };
    edges.push(edgeObj);

    if (relation === "MEASURED_OUTCOME" || relation === "OBSERVED_HARM") {
      if (!outcomeIndex[t]) outcomeIndex[t] = [];
      outcomeIndex[t].push(edgeObj);
    }
  }

  log("graph", "Compiling knowledge graph from records and MDX documentation...");

  // 1. Process Enriched Evidence Records (09-record.json or 05-evidence.json)
  if (existsSync(ENRICHED_DIR)) {
    const entries = readdirSync(ENRICHED_DIR, { withFileTypes: true });
    const docIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    for (const docId of docIds) {
      const recPath = join(ENRICHED_DIR, docId, "09-record.json");
      const builderPath = join(ENRICHED_DIR, docId, "05-evidence.json");
      const gatesPath = join(ENRICHED_DIR, docId, "gates.json");

      let record = readJson(recPath);
      if (!record && existsSync(builderPath)) {
        record = readJson(builderPath);
      }
      if (!record) continue;

      const gates = readJson(gatesPath, { passed: true });
      const paperNodeId = `paper:${docId}`;

      const title = record.title?.value ?? docId;
      const year = record.study?.year?.value ?? record.published?.value;
      const doi = record.doi?.value;
      const documentKind = record.document_kind;

      addNode(paperNodeId, "Document", {
        slug: docId,
        title,
        year,
        doi,
        documentKind,
        gatesPassed: gates?.passed ?? false,
      });

      // Drug / Intervention
      const interventionVal = record.study?.intervention?.value;
      const drugs = cleanDrugNames(interventionVal);
      for (const drugName of drugs) {
        const drugId = `drug:${slugify(drugName)}`;
        addNode(drugId, "Intervention", { name: drugName, description: interventionVal });
        addEdge(paperNodeId, drugId, "EVALUATES_INTERVENTION");
      }

      // NCT Trial IDs (Primary associations)
      const nctList = Array.isArray(record.study?.nct_ids) ? record.study.nct_ids : [];
      for (const nct of nctList) {
        if (!nct || typeof nct !== "string") continue;
        const cleanNct = nct.trim().toUpperCase();
        const trialId = `trial:${cleanNct}`;
        addNode(trialId, "ClinicalTrial", { nct: cleanNct });
        addEdge(paperNodeId, trialId, "REPORTS_TRIAL");
        for (const drugName of drugs) {
          addEdge(`drug:${slugify(drugName)}`, trialId, "TESTED_IN_TRIAL");
        }
      }

      // Outcomes
      const outcomes = record.outcomes ?? [];
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        const rawName = outcome.name && typeof outcome.name === "string" ? outcome.name.trim() : "";
        const outcomeSlug = rawName ? slugify(rawName) : `unnamed-outcome-${docId}-${i}`;
        const outcomeId = `outcome:${outcomeSlug}`;
        const polarity = outcome.polarity || "unspecified";

        addNode(outcomeId, "OutcomeMeasure", { name: rawName || outcomeSlug, polarity });
        addEdge(paperNodeId, outcomeId, "MEASURED_OUTCOME", {
          tier: outcome.tier,
          prespecified: outcome.prespecified,
          met: outcome.met,
          effect: outcome.effect_estimate,
          ci: outcome.confidence_interval,
          pValue: outcome.p_value,
          multiplicity: outcome.multiplicity_controlled,
          quote: outcome.quote,
          location: outcome.location,
          polarity,
        });
      }

      // Harms / Safety Signals
      const harms = record.safety?.harms ?? [];
      for (let j = 0; j < harms.length; j++) {
        const harm = harms[j];
        const rawHarmName = harm.name && typeof harm.name === "string" ? harm.name.trim() : "";
        const harmSlug = rawHarmName ? slugify(rawHarmName) : `unnamed-harm-${docId}-${j}`;
        const harmId = `harm:${harmSlug}`;
        addNode(harmId, "Harm", { name: rawHarmName || harmSlug });
        addEdge(paperNodeId, harmId, "OBSERVED_HARM", {
          arm: harm.arm,
          count: harm.count,
          denominator: harm.denominator,
          percentage: harm.percentage,
          apoeStratum: harm.apoe_stratum,
          quote: harm.quote,
          location: harm.location,
        });
      }
    }
  }

  // 2. Process Published MDX Papers in docs/research/papers/
  if (existsSync(PAPERS_DIR)) {
    const entries = readdirSync(PAPERS_DIR, { withFileTypes: true });
    const paperFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".mdx") && e.name !== "index.mdx").map((e) => e.name);

    for (const file of paperFiles) {
      try {
        const slug = file.replace(/\.mdx$/, "");
        const fullPath = join(PAPERS_DIR, file);
        const text = readFileSync(fullPath, "utf8");
        const frontmatter = extractFrontmatter(text, fullPath);
        const paperNodeId = `paper:${slug}`;

        addNode(paperNodeId, "Document", {
          slug,
          title: frontmatter.title || slug,
          doi: frontmatter.doi,
          year: frontmatter.year ? String(frontmatter.year) : undefined,
          publishedMdx: true,
        });

        // Extract Drugs from frontmatter
        if (frontmatter.drug) {
          const drugs = cleanDrugNames(frontmatter.drug);
          for (const drugName of drugs) {
            const drugId = `drug:${slugify(drugName)}`;
            addNode(drugId, "Intervention", { name: drugName });
            addEdge(paperNodeId, drugId, "EVALUATES_INTERVENTION");
          }
        }

        // Extract Tags as Targets / Mechanisms
        const tags = frontmatter.search?.tags || frontmatter.tags || [];
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            const targetNodeId = `target:${slugify(tag)}`;
            addNode(targetNodeId, "BiologicalTarget", { name: tag });
            addEdge(paperNodeId, targetNodeId, "STUDIES_TARGET");
          }
        }

        // Extract explicit trials from frontmatter safely
        const rawTrials = frontmatter.trial || frontmatter.nct;
        if (rawTrials) {
          const trialsList = Array.isArray(rawTrials) ? rawTrials : [rawTrials];
          for (const t of trialsList) {
            if (t && typeof t === "string") {
              const cleanT = t.trim().toUpperCase();
              const trialId = `trial:${cleanT}`;
              addNode(trialId, "ClinicalTrial", { nct: cleanT });
              addEdge(paperNodeId, trialId, "REPORTS_TRIAL");
            }
          }
        }
      } catch (err) {
        console.warn(`[warn] Failed to read paper MDX file ${file}: ${err.message}`);
      }
    }
  }

  // 3. Process MDX Trial Pages
  if (existsSync(TRIALS_DIR)) {
    const entries = readdirSync(TRIALS_DIR, { withFileTypes: true });
    const trialFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".mdx") && e.name !== "index.mdx").map((e) => e.name);

    for (const file of trialFiles) {
      try {
        const slug = file.replace(/\.mdx$/, "");
        const fullPath = join(TRIALS_DIR, file);
        const text = readFileSync(fullPath, "utf8");
        const frontmatter = extractFrontmatter(text, fullPath);

        const nctMatches = text.match(/NCT\d{8}/gi) || [];
        const rawNct = frontmatter.nct || frontmatter.trial;
        const nctList = Array.isArray(rawNct)
          ? rawNct
          : rawNct
            ? [rawNct]
            : nctMatches.length > 0
              ? nctMatches
              : [];

        for (const nctItem of nctList) {
          if (!nctItem || typeof nctItem !== "string") continue;
          const cleanNct = nctItem.trim().toUpperCase();
          const trialNodeId = `trial:${cleanNct}`;

          addNode(trialNodeId, "ClinicalTrial", {
            slug,
            title: frontmatter.title || slug,
            nct: cleanNct,
            phase: frontmatter.phase,
            status: frontmatter.status,
          });

          // Extract Drugs from frontmatter
          if (frontmatter.drug) {
            const drugs = cleanDrugNames(frontmatter.drug);
            for (const drugName of drugs) {
              const drugId = `drug:${slugify(drugName)}`;
              addNode(drugId, "Intervention", { name: drugName });
              addEdge(drugId, trialNodeId, "TESTED_IN_TRIAL");
            }
          }

          // Tags & Targets
          const tags = frontmatter.search?.tags || frontmatter.tags || [];
          if (Array.isArray(tags)) {
            for (const tag of tags) {
              const targetNodeId = `target:${slugify(tag)}`;
              addNode(targetNodeId, "BiologicalTarget", { name: tag });
              addEdge(trialNodeId, targetNodeId, "TARGETS_PATHOLOGY");
            }
          }
        }
      } catch (err) {
        console.warn(`[warn] Failed to read trial MDX file ${file}: ${err.message}`);
      }
    }
  }

  // 4. Process Topic Syntheses
  if (existsSync(TOPICS_DIR)) {
    const entries = readdirSync(TOPICS_DIR, { withFileTypes: true });
    const topicFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".mdx") && e.name !== "index.mdx" && e.name !== "authors.mdx")
      .map((e) => e.name);

    for (const file of topicFiles) {
      try {
        const slug = file.replace(/\.mdx$/, "");
        const fullPath = join(TOPICS_DIR, file);
        const text = readFileSync(fullPath, "utf8");
        const frontmatter = extractFrontmatter(text, fullPath);
        const topicId = `topic:${slug}`;

        addNode(topicId, "Topic", { slug, title: frontmatter.title || slug });

        // Cross links to trials and papers
        const paperRefs = text.match(/\/research\/papers\/([a-zA-Z0-9\-_]+)/g) || [];
        for (const ref of new Set(paperRefs)) {
          const pSlug = ref.replace("/research/papers/", "");
          const paperId = `paper:${pSlug}`;
          addEdge(topicId, paperId, "SYNTHESIZES_PAPER");
        }

        const trialRefs = text.match(/\/trials\/([a-zA-Z0-9\-_]+)/g) || [];
        for (const ref of new Set(trialRefs)) {
          const tSlug = ref.replace("/trials/", "");
          addEdge(topicId, `trial:${tSlug.toUpperCase()}`, "SYNTHESIZES_TRIAL");
        }
      } catch (err) {
        console.warn(`[warn] Failed to read topic MDX file ${file}: ${err.message}`);
      }
    }
  }

  // 5. Build Forward & Reverse Adjacency Tables with null-prototypes
  const forwardAdjacency = Object.create(null);
  const reverseAdjacency = Object.create(null);

  for (const edge of edges) {
    if (!forwardAdjacency[edge.source]) forwardAdjacency[edge.source] = [];
    forwardAdjacency[edge.source].push({
      key: edge.key,
      target: edge.target,
      relation: edge.relation,
      properties: edge.properties,
    });

    if (!reverseAdjacency[edge.target]) reverseAdjacency[edge.target] = [];
    reverseAdjacency[edge.target].push({
      key: edge.key,
      source: edge.source,
      relation: edge.relation,
      properties: edge.properties,
    });
  }

  const compiled = {
    metadata: {
      generatedAt: new Date().toISOString(),
      nodeCount: nodes.size,
      edgeCount: edges.length,
    },
    nodes: Array.from(nodes.values()),
    edges,
    outcomeIndex,
    forwardAdjacency,
    reverseAdjacency,
  };

  const distDir = join(ROOT, "dist");
  ensureDir(distDir);
  const outPath = join(distDir, "graph.json");

  // Stream serialization to avoid V8 string memory limits
  const stream = createWriteStream(outPath, { encoding: "utf8" });
  stream.write('{"metadata":' + JSON.stringify(compiled.metadata) + ',"nodes":[');
  let firstNode = true;
  for (const node of compiled.nodes) {
    if (!firstNode) stream.write(",");
    firstNode = false;
    stream.write(JSON.stringify(node));
  }
  stream.write('],"edges":[');
  let firstEdge = true;
  for (const edge of compiled.edges) {
    if (!firstEdge) stream.write(",");
    firstEdge = false;
    stream.write(JSON.stringify(edge));
  }
  stream.write('],"outcomeIndex":' + JSON.stringify(compiled.outcomeIndex));
  stream.write(',"forwardAdjacency":' + JSON.stringify(compiled.forwardAdjacency));
  stream.write(',"reverseAdjacency":' + JSON.stringify(compiled.reverseAdjacency) + "}");
  stream.end();

  log("graph", `Knowledge graph generated: ${nodes.size} nodes, ${edges.length} edges -> dist/graph.json`);
  return compiled;
}

if (process.argv[1] && process.argv[1].endsWith("build-graph.mjs")) {
  compileKnowledgeGraph();
}
