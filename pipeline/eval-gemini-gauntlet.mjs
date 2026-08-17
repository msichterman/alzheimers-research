#!/usr/bin/env node
// Live LLM Evaluation Gauntlet using Gemini 3.1 Pro Preview subagents
// Usage: node pipeline/eval-gemini-gauntlet.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_AVAILABLE, MODELS, S, gemini } from "./gemini.mjs";
import { loadGraph, queryEvidenceMatrix, traverseGraph, verifyQuoteAgainstSource } from "./graph-query.mjs";
import { ROOT, log, readJson } from "./lib.mjs";

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

async function geminiWithRetry(prompt, options, maxAttempts = 2) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await gemini(prompt, options);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        log("eval", `Retrying Gemini call (attempt ${attempt + 1}/${maxAttempts})...`);
      }
    }
  }
  throw lastErr;
}

async function runGeminiGauntlet() {
  console.log("\n=======================================================");
  console.log("  🧠 RUNNING LIVE GEMINI 3.1 PRO GRAPHRAG EVAL GAUNTLET");
  console.log("=======================================================");

  if (!GEMINI_AVAILABLE) {
    console.error("Vertex AI credentials not available. Exiting.");
    process.exit(1);
  }

  const graph = loadGraph();
  assert(graph !== null, "Knowledge graph artifact loaded");

  // Dynamically select an RCT trial paper node with measured outcomes
  const outcomeEdge = graph.edges.find((e) => e.relation === "MEASURED_OUTCOME" && e.properties?.met !== undefined);
  const targetPaperId = outcomeEdge ? outcomeEdge.source : "paper:gosuranemab-tango";

  // --- SUBAGENT TEST 1: Multi-Hop Clinical Graph Traversal ---
  console.log(`\n\x1b[34m[STAGE 1] Testing Gemini 3.1 Pro Subagent on Multi-Hop Graph Traversal (${targetPaperId})\x1b[0m`);

  const traversal = traverseGraph(targetPaperId, { direction: "out", maxDepth: 2 });
  const validNodes = traversal.nodes.slice(0, 25);
  const validNodeIds = new Set(validNodes.map((n) => n.id));
  const validEdges = traversal.edges.filter((e) => validNodeIds.has(e.from) && validNodeIds.has(e.to));

  const boundedContext = {
    root: targetPaperId,
    nodes: validNodes,
    edges: validEdges,
  };
  const graphContext = JSON.stringify(boundedContext, null, 2);

  const prompt1 = `You are a clinical trials research subagent. Analyze the following knowledge graph neighborhood extracted from an Alzheimer's clinical trial study:

${graphContext}

Answer the following questions strictly in JSON:
1. What drug / intervention was tested?
2. What was a primary or secondary endpoint outcome reported in the graph?
3. Did the study meet that endpoint threshold (true, false, or null if diagnostic/not applicable)?
4. What is your clinical evidence summary?`;

  const schema1 = S.obj(
    {
      drug: S.str("name of the drug or intervention"),
      endpoint_name: S.str("name of the clinical endpoint"),
      endpoint_met: S.bool("did endpoint meet threshold or null"),
      summary: S.str("brief evidence summary"),
    },
    ["drug", "endpoint_name", "summary"],
  );

  log("eval", `Invoking Gemini 3.1 Pro for Multi-Hop Graph Traversal on ${targetPaperId}...`);
  const res1 = await geminiWithRetry(prompt1, { model: MODELS.pro, schema: schema1 });
  log("eval", `Gemini 3.1 Pro Response received: ${JSON.stringify(res1.json)}`);

  const drugName = String(res1.json?.drug || "").toLowerCase().trim();
  assert(drugName.length > 0 && drugName !== "undefined" && drugName !== "null", `Identified tested intervention: ${res1.json?.drug}`);
  assert(res1.json?.endpoint_met !== undefined, "Extracted clinical endpoint threshold status");
  assert(String(res1.json?.summary || "").length > 10, "Generated evidence-grounded summary");

  // --- SUBAGENT TEST 2: Adversarial Spin & Subgroup Distractor Defense ---
  console.log("\n\x1b[34m[STAGE 2] Testing Gemini 3.1 Pro Subagent on Spin & Subgroup Distractor Defense\x1b[0m");

  const matrixData = queryEvidenceMatrix("CDR-SB", { tier: "secondary" });
  const prompt2 = `You are an expert clinical evidence adjudicator.
A press release claims: "Our anti-tau antibody achieved remarkable clinical benefit in Alzheimer's patients in an exploratory post-hoc subgroup."

Here are the verified outcome records from the clinical evidence graph:
${JSON.stringify(matrixData.matrix.slice(0, 5), null, 2)}

Evaluate this claim strictly in JSON:
1. Is a post-hoc subgroup benefit considered evidence of clinical efficacy?
2. How should an evidence-based knowledge base classify this claim?
3. What is the ground-truth standard for prespecified vs post-hoc outcomes?`;

  const schema2 = S.obj(
    {
      valid_evidence: S.bool("is post-hoc subgroup claim valid clinical evidence"),
      verdict: S.str("one of: verified, unsupported_spin, indeterminate"),
      rule: S.str("the scientific rule applied"),
    },
    ["valid_evidence", "verdict", "rule"],
  );

  log("eval", "Invoking Gemini 3.1 Pro for Spin Defense Adjudication...");
  const res2 = await geminiWithRetry(prompt2, { model: MODELS.pro, schema: schema2 });
  log("eval", `Gemini 3.1 Pro Verdict: ${JSON.stringify(res2.json)}`);

  const verdictStr = String(res2.json?.verdict || "").toLowerCase();
  assert(res2.json?.valid_evidence === false, "Rejected post-hoc subgroup claim as primary evidence");
  assert(verdictStr.includes("unsupported") || verdictStr.includes("spin"), "Classified press release claim as unsupported spin");

  // --- SUBAGENT TEST 3: Verbatim Grounding & Quote Verification ---
  console.log("\n\x1b[34m[STAGE 3] Testing Verbatim Quote Fidelity Gate\x1b[0m");

  const sampleOutcome = graph.edges.find((e) => e.relation === "MEASURED_OUTCOME" && e.properties?.quote);
  assert(sampleOutcome !== undefined, "Found measured outcome with verbatim quote in graph");

  if (sampleOutcome) {
    const docSlug = sampleOutcome.source.replace("paper:", "");
    const check = verifyQuoteAgainstSource(docSlug, sampleOutcome.properties.quote);
    assert(check.verified, `Verbatim quote grounded in primary document raw/${docSlug}/document.md (${check.mode})`);
  }

  console.log("\n=======================================================");
  if (failedCount === 0) {
    console.log(`  \x1b[32m✔ ALL ${passedCount} GEMINI 3.1 PRO GAUNTLET TESTS PASSED PERFECTLY!\x1b[0m`);
    console.log("=======================================================\n");
    process.exit(0);
  } else {
    console.error(`  \x1b[31m✖ GEMINI GAUNTLET FAILED: ${failedCount} tests failed, ${passedCount} passed.\x1b[0m`);
    console.log("=======================================================\n");
    process.exit(1);
  }
}

runGeminiGauntlet();
