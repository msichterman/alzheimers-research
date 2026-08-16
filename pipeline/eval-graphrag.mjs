#!/usr/bin/env node
// Full Evaluation Gauntlet for Git-Based GraphRAG & Search Engine
// Usage: node pipeline/eval-graphrag.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileKnowledgeGraph } from "./build-graph.mjs";
import { loadGraph, queryEvidenceMatrix, traverseGraph, verifyQuoteAgainstSource } from "./graph-query.mjs";
import { ROOT, log } from "./lib.mjs";

let passedCount = 0;
let failedCount = 0;

function assert(condition, testName, details = "") {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m ${testName}`);
    passedCount++;
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${testName} ${details ? `(${details})` : ""}`);
    failedCount++;
  }
}

async function runGauntlet() {
  console.log("\n=======================================================");
  console.log("  🚀 RUNNING FULL GRAPHRAG & SEARCH EVAL GAUNTLET");
  console.log("=======================================================\n");

  // --- GATE 1: Graph Compilation & Structural Integrity ---
  console.log("\x1b[34m[STAGE 1] Testing Graph Compilation & Schema Topology\x1b[0m");
  const graphData = compileKnowledgeGraph();
  assert(graphData && graphData.nodes.length > 0, "Graph compiles and has nodes", `Count: ${graphData.nodes.length}`);
  assert(graphData.edges.length > 0, "Graph has relational edges", `Count: ${graphData.edges.length}`);
  assert(existsSync(join(ROOT, "dist", "graph.json")), "dist/graph.json is serialized to disk");

  const graph = loadGraph();
  assert(graph !== null, "Graph loads into in-memory engine cleanly");

  // Reciprocity check: forward -> reverse
  let forwardReciprocityErrors = 0;
  for (const [source, outEdges] of Object.entries(graph.forwardAdjacency)) {
    for (const edge of outEdges) {
      const reverseList = graph.reverseAdjacency[edge.target] || [];
      const hasMatch = reverseList.some((r) => r.source === source && r.relation === edge.relation);
      if (!hasMatch) forwardReciprocityErrors++;
    }
  }
  assert(forwardReciprocityErrors === 0, "Adjacency matrix has forward-to-reverse reciprocity");

  // Reciprocity check: reverse -> forward
  let reverseReciprocityErrors = 0;
  for (const [target, inEdges] of Object.entries(graph.reverseAdjacency)) {
    for (const edge of inEdges) {
      const forwardList = graph.forwardAdjacency[edge.source] || [];
      const hasMatch = forwardList.some((f) => f.target === target && f.relation === edge.relation);
      if (!hasMatch) reverseReciprocityErrors++;
    }
  }
  assert(reverseReciprocityErrors === 0, "Adjacency matrix has reverse-to-forward reciprocity");

  // --- GATE 2: Multi-Hop Relational Traversal ---
  console.log("\n\x1b[34m[STAGE 2] Testing Multi-Hop Traversal (Drug -> Target -> Trial -> Outcome)\x1b[0m");
  
  // Find a known paper node in the graph
  const paperNode = graph.nodes.find((n) => n.type === "Document");
  assert(paperNode !== undefined, "Found at least one Document node in the graph");

  if (paperNode) {
    const traversal = traverseGraph(paperNode.id, { direction: "out", maxDepth: 2 });
    assert(traversal.edges.length > 0, `Traversed out-edges from ${paperNode.id}`, `Edges found: ${traversal.edges.length}`);
    assert(traversal.totalVisited > 1, `Discovered connected sub-graph`, `Nodes visited: ${traversal.totalVisited}`);
  }

  // --- GATE 3: Quantitative Evidence Matrix Queries ---
  console.log("\n\x1b[34m[STAGE 3] Testing Clinical Outcome Matrix Engine\x1b[0m");
  
  const cdrResult = queryEvidenceMatrix("CDR-SB");
  assert(cdrResult.count > 0, "Query 'CDR-SB' returns structured outcomes across corpus", `Matches: ${cdrResult.count}`);

  const anyOutcome = cdrResult.matrix[0];
  if (anyOutcome) {
    assert(typeof anyOutcome.sourceDocument === "string", "Outcome matrix contains sourceDocument pointer");
    assert(anyOutcome.tier !== undefined, "Outcome matrix carries prespecified tier");
    assert(anyOutcome.met !== undefined, "Outcome matrix carries endpoint met/not_met status");
    assert(anyOutcome.polarity !== undefined, "Outcome matrix carries scale polarity (e.g. lower_is_better)");
  } else {
    assert(false, "Outcome matrix returned empty results");
  }

  // --- GATE 4: Verbatim Quote & Provenance Verification Gate ---
  console.log("\n\x1b[34m[STAGE 4] Testing Verbatim Quote Grounding in Primary Markdown\x1b[0m");

  let quotesTested = 0;
  let quotesVerified = 0;

  for (const edge of graph.edges) {
    if (edge.relation === "MEASURED_OUTCOME" && edge.properties?.quote) {
      const docSlug = edge.source.replace("paper:", "");
      const res = verifyQuoteAgainstSource(docSlug, edge.properties.quote);
      quotesTested++;
      if (res.verified) {
        quotesVerified++;
      }
    }
    if (quotesTested >= 20) break; // Sample first 20 outcome quotes
  }

  assert(quotesTested > 0, "Sampled extracted outcome quotes for verification", `Sampled: ${quotesTested}`);
  assert(quotesVerified > 0, "Quotes verified as exact substrings in raw/ source markdown", `Verified: ${quotesVerified}/${quotesTested}`);

  // --- GATE 5: Search & Blume Config Verification ---
  console.log("\n\x1b[34m[STAGE 5] Testing Blume Preset & Config Resolution\x1b[0m");
  assert(existsSync(join(ROOT, "config", "preset-graphrag.ts")), "GraphRAG preset is installed at config/preset-graphrag.ts");
  assert(existsSync(join(ROOT, "config", "define-research-config.ts")), "Config factory is installed at config/define-research-config.ts");

  console.log("\n=======================================================");
  if (failedCount === 0) {
    console.log(`  \x1b[32m✔ ALL ${passedCount} GAUNTLET TESTS PASSED PERFECTLY!\x1b[0m`);
    console.log("=======================================================\n");
    process.exit(0);
  } else {
    console.error(`  \x1b[31m✖ GAUNTLET FAILED: ${failedCount} tests failed, ${passedCount} passed.\x1b[0m`);
    console.log("=======================================================\n");
    process.exit(1);
  }
}

runGauntlet();
