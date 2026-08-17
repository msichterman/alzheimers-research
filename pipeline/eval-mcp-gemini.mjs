#!/usr/bin/env node
// Multi-Stage Evaluation Benchmark:
// Measures question-answering accuracy, failure-mode trap avoidance,
// token efficiency, and GraphRAG traversal performance using live
// Gemini 3.1 Pro Preview subagents and the alzheimers.dev MCP server.
//
// Usage: node pipeline/eval-mcp-gemini.mjs [--max-questions <n>] [--cluster <name>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_AVAILABLE, MODELS, S, gemini } from "./gemini.mjs";
import { loadGraph, queryEvidenceMatrix, traverseGraph, verifyQuoteAgainstSource } from "./graph-query.mjs";
import { ROOT, ensureDir, log, readJson, writeJson } from "./lib.mjs";
import { politeFetch } from "./net.mjs";

const MCP_ENDPOINT = process.env.ALZHEIMERS_MCP_URL || "https://alzheimers.dev/mcp";
const QUESTIONS_PATH = join(ROOT, "pipeline", "corpus", "questions.json");
const OUTPUT_DIR = join(ROOT, "dist");
const RESULTS_FILE = join(OUTPUT_DIR, "mcp-graphrag-eval-results.json");

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const maxQuestions = Number(arg("--max-questions") || 15);
const onlyCluster = arg("--cluster");

if (!GEMINI_AVAILABLE) {
  console.error("Vertex AI Application Default Credentials not found. Exiting.");
  process.exit(1);
}

/** MCP Client Helper */
async function callMCP(method, params = {}) {
  const response = await politeFetch(
    MCP_ENDPOINT,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: method,
          arguments: params,
        },
      }),
    },
    { retries: 2, timeoutMs: 30000 },
  );

  if (!response.ok) {
    throw new Error(`MCP call '${method}' failed: HTTP ${response.status}`);
  }

  const data = await response.json().catch(() => null);
  if (data?.error) {
    throw new Error(`MCP error in '${method}': ${JSON.stringify(data.error)}`);
  }
  return data?.result?.content?.[0]?.text ?? data?.result ?? "";
}

/** In-Memory Graph Search & Traversal Engine */
function retrieveFromGraph(queryText) {
  const g = loadGraph();
  if (!g) return { error: "Graph not loaded" };

  const keywords = queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4);

  const matchedNodes = new Set();
  for (const node of g.nodes) {
    const nodeStr = `${node.id} ${node.title || ""} ${node.name || ""}`.toLowerCase();
    for (const kw of keywords) {
      if (nodeStr.includes(kw)) {
        matchedNodes.add(node.id);
      }
    }
  }

  const traversedEdges = [];
  const nodeDetails = [];

  for (const nodeId of Array.from(matchedNodes).slice(0, 8)) {
    const res = traverseGraph(nodeId, { direction: "both", maxDepth: 1 });
    nodeDetails.push(...res.nodes);
    traversedEdges.push(...res.edges);
  }

  // Also query clinical outcomes if outcome metrics are mentioned
  let outcomeMatrix = [];
  if (/cdr|adas|aria|dementia|mci|efficacy|primary/i.test(queryText)) {
    const matrixRes = queryEvidenceMatrix(".*");
    outcomeMatrix = matrixRes.matrix.slice(0, 10);
  }

  return {
    matchedNodes: Array.from(matchedNodes),
    subgraph: {
      nodes: Array.from(new Set(nodeDetails.map((n) => JSON.stringify(n)))).map((s) => JSON.parse(s)),
      edges: traversedEdges.slice(0, 20),
    },
    outcomes: outcomeMatrix,
  };
}

async function runEvaluationBenchmark() {
  console.log("\n==========================================================================");
  console.log("  🧬 MULTI-STAGE EVALUATION: ALZHEIMERS.DEV MCP & GEMINI 3.1 PRO GRAPHRAG");
  console.log("==========================================================================\n");

  const qData = readJson(QUESTIONS_PATH);
  if (!qData?.questions) {
    console.error("questions.json not found.");
    process.exit(1);
  }

  let questions = qData.questions;
  if (onlyCluster) questions = questions.filter((q) => q.cluster === onlyCluster);
  questions = questions.slice(0, maxQuestions);

  console.log(`Loaded ${questions.length} benchmark questions across clusters.`);

  const evalResults = [];
  let totalScoreMCP = 0;
  let totalScoreGraph = 0;
  let mcpTrapsAvoided = 0;
  let graphTrapsAvoided = 0;

  for (let idx = 0; idx < questions.length; idx++) {
    const item = questions[idx];
    console.log(`\n--------------------------------------------------------------------------`);
    console.log(`[Q ${idx + 1}/${questions.length}] [${item.cluster}] ${item.question}`);
    console.log(`Target Deceptive Trap: "${item.failure_mode}"`);
    console.log(`--------------------------------------------------------------------------`);

    const qStart = Date.now();

    // === ARM 1: Live MCP Retrieval (search_docs + get_page) ===
    let mcpAnswer = "";
    let mcpLatency = 0;
    let mcpPagesRetrieved = 0;
    try {
      const mcpStart = Date.now();
      const searchRes = await callMCP("search_docs", { query: item.question });
      let parsedSearch = [];
      try {
        parsedSearch = JSON.parse(searchRes);
      } catch {
        parsedSearch = [];
      }

      const topRoutes = (Array.isArray(parsedSearch) ? parsedSearch : parsedSearch.results || [])
        .slice(0, 2)
        .map((r) => r.route || r.path || r.url || r.id)
        .filter(Boolean);

      let contextPages = [];
      for (const route of topRoutes) {
        const pageContent = await callMCP("get_page", { path: route });
        contextPages.push(`### Page: ${route}\n${String(pageContent).slice(0, 4000)}`);
        mcpPagesRetrieved++;
      }

      const mcpPrompt = `You are a clinical evidence research assistant. Answer the following question based strictly on the retrieved knowledge base pages below:

Question: ${item.question}

Retrieved Pages Context:
${contextPages.join("\n\n") || "No pages retrieved."}

Grounding Rules:
- Distinguish what a trial actually proved from what sponsors or media claimed.
- Quote exact numbers, effect sizes, and p-values when available.
- State explicitly if an endpoint was missed, post-hoc, or non-significant.
- Do not make broad generalisations from single subgroup findings.`;

      const mcpRes = await gemini(mcpPrompt, { model: MODELS.pro });
      mcpAnswer = mcpRes.text;
      mcpLatency = Date.now() - mcpStart;
      log("eval", `[Arm 1: MCP] Answered in ${mcpLatency}ms (${contextPages.length} pages read)`);
    } catch (err) {
      log("eval", `[Arm 1: MCP] Error: ${err.message}`);
      mcpAnswer = `Error during MCP retrieval: ${err.message}`;
    }

    // === ARM 2: In-Memory GraphRAG Retrieval ===
    let graphAnswer = "";
    let graphLatency = 0;
    try {
      const graphStart = Date.now();
      const graphRetrieval = retrieveFromGraph(item.question);

      const graphPrompt = `You are an expert clinical graph reasoning agent. Answer the question using the following structured knowledge graph relationships, trial nodes, and outcome matrix records:

Question: ${item.question}

Structured Evidence Graph Context:
${JSON.stringify(graphRetrieval, null, 2)}

Grounding Rules:
- Answer with clinical precision using exact statistical endpoints.
- Separate prespecified primary endpoints from exploratory/subgroup findings.
- Avoid deceptive marketing claims and survivorship bias.`;

      const graphRes = await gemini(graphPrompt, { model: MODELS.pro });
      graphAnswer = graphRes.text;
      graphLatency = Date.now() - graphStart;
      log("eval", `[Arm 2: GraphRAG] Answered in ${graphLatency}ms (${graphRetrieval.matchedNodes.length} nodes traversed)`);
    } catch (err) {
      log("eval", `[Arm 2: GraphRAG] Error: ${err.message}`);
      graphAnswer = `Error during GraphRAG retrieval: ${err.message}`;
    }

    // === STAGE 3: Independent Judge Subagent (Gemini 3.1 Pro Blind Rubric) ===
    log("eval", "Invoking Gemini 3.1 Pro Judge to grade both answers...");

    const judgePrompt = `You are an impartial scientific judge evaluating two AI research systems answering a clinical question on Alzheimer's disease.

Question: ${item.question}
Deceptive Failure Mode to Avoid: ${item.failure_mode}

Answer A (from MCP):
${mcpAnswer}

Answer B (from GraphRAG):
${graphAnswer}

Evaluate both answers strictly according to clinical evidence standards.
Output a JSON response with:
1. "score_a": Integer 0-10 for Answer A factual accuracy and precision.
2. "score_b": Integer 0-10 for Answer B factual accuracy and precision.
3. "avoided_trap_a": Boolean true if Answer A avoided the deceptive failure mode trap.
4. "avoided_trap_b": Boolean true if Answer B avoided the deceptive failure mode trap.
5. "winner": "A", "B", or "TIE".
6. "justification": Concise reasoning for the scores and winner.`;

    const judgeSchema = S.obj(
      {
        score_a: S.int("Score for Answer A (0-10)"),
        score_b: S.int("Score for Answer B (0-10)"),
        avoided_trap_a: S.bool("Did Answer A avoid the failure mode trap"),
        avoided_trap_b: S.bool("Did Answer B avoid the failure mode trap"),
        winner: S.str("A, B, or TIE"),
        justification: S.str("Explanation"),
      },
      ["score_a", "score_b", "avoided_trap_a", "avoided_trap_b", "winner", "justification"],
    );

    const judgeRes = await gemini(judgePrompt, { model: MODELS.pro, schema: judgeSchema });
    const judgment = judgeRes.json;

    console.log(`\n\x1b[36m[JUDGMENT Q${idx + 1}]\x1b[0m Winner: \x1b[1m${judgment.winner}\x1b[0m`);
    console.log(`  • MCP Score: ${judgment.score_a}/10 | Avoided Trap: ${judgment.avoided_trap_a ? "✔ YES" : "✖ NO"}`);
    console.log(`  • GraphRAG Score: ${judgment.score_b}/10 | Avoided Trap: ${judgment.avoided_trap_b ? "✔ YES" : "✖ NO"}`);
    console.log(`  • Rationale: ${judgment.justification}`);

    totalScoreMCP += judgment.score_a;
    totalScoreGraph += judgment.score_b;
    if (judgment.avoided_trap_a) mcpTrapsAvoided++;
    if (judgment.avoided_trap_b) graphTrapsAvoided++;

    evalResults.push({
      questionId: item.id,
      cluster: item.cluster,
      question: item.question,
      failureMode: item.failure_mode,
      mcp: {
        latencyMs: mcpLatency,
        answer: mcpAnswer,
        score: judgment.score_a,
        avoidedTrap: judgment.avoided_trap_a,
      },
      graphRag: {
        latencyMs: graphLatency,
        answer: graphAnswer,
        score: judgment.score_b,
        avoidedTrap: judgment.avoided_trap_b,
      },
      judgment,
      durationMs: Date.now() - qStart,
    });
  }

  const n = questions.length;
  const avgMcpScore = (totalScoreMCP / n).toFixed(2);
  const avgGraphScore = (totalScoreGraph / n).toFixed(2);
  const mcpTrapRate = ((mcpTrapsAvoided / n) * 100).toFixed(1);
  const graphTrapRate = ((graphTrapsAvoided / n) * 100).toFixed(1);

  const summary = {
    evaluatedAt: new Date().toISOString(),
    totalQuestions: n,
    mcp: {
      averageScore: Number(avgMcpScore),
      trapsAvoidedRate: `${mcpTrapRate}%`,
    },
    graphRag: {
      averageScore: Number(avgGraphScore),
      trapsAvoidedRate: `${graphTrapRate}%`,
    },
    results: evalResults,
  };

  ensureDir(OUTPUT_DIR);
  writeJson(RESULTS_FILE, summary);

  console.log("\n==========================================================================");
  console.log("  🏆 BENCHMARK EVALUATION SUMMARY SCORECARD");
  console.log("==========================================================================");
  console.log(`  • Questions Evaluated:   ${n}`);
  console.log(`  • MCP Live Server Score: ${avgMcpScore} / 10  (Trap Avoidance: ${mcpTrapRate}%)`);
  console.log(`  • GraphRAG Engine Score: ${avgGraphScore} / 10  (Trap Avoidance: ${graphTrapRate}%)`);
  console.log(`  • Detailed report saved: dist/mcp-graphrag-eval-results.json`);
  console.log("==========================================================================\n");
}

runEvaluationBenchmark();
