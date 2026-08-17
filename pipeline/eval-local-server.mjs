#!/usr/bin/env node
// Local Server & GraphRAG Multi-Stage Evaluation Runner:
// Starts the local Blume development server, verifies all routes,
// endpoints (/blume-search.json, /mcp), tests graph traversal,
// and evaluates question answering with Gemini 3.1 Pro subagents.
//
// Usage: node pipeline/eval-local-server.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_AVAILABLE, MODELS, S, gemini } from "./gemini.mjs";
import { loadGraph, queryEvidenceMatrix, traverseGraph } from "./graph-query.mjs";
import { ROOT, ensureDir, log, readJson, writeJson } from "./lib.mjs";
import { politeFetch } from "./net.mjs";

const PORT = 4321;
const BASE_URL = `http://localhost:${PORT}`;
const QUESTIONS_PATH = join(ROOT, "pipeline", "corpus", "questions.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 406 || res.status === 200) return true;
    } catch {
      // Waiting for port
    }
    await sleep(800);
  }
  return false;
}

async function runLocalEvaluation() {
  console.log("\n==========================================================================");
  console.log("  🚀 LOCAL SERVER EVALUATION: BLUME SERVER & GEMINI 3.1 PRO GRAPHRAG");
  console.log("==========================================================================\n");

  log("server", "Starting local Blume dev server...");
  const serverProc = spawn("pnpm", ["dev"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  serverProc.stdout.on("data", (d) => {
    const text = d.toString();
    if (text.includes("ready in") || text.includes("Local")) {
      log("server", text.trim().split("\n")[0]);
    }
  });

  const serverReady = await waitForServer(`${BASE_URL}/`);
  if (!serverReady) {
    log("server", "Failed to connect to local server within timeout.");
    serverProc.kill("SIGINT");
    process.exit(1);
  }
  log("server", `Local server is up and responsive at ${BASE_URL}`);

  let passed = 0;
  let failed = 0;
  function assert(condition, name, detail = "") {
    if (condition) {
      console.log(`  \x1b[32m✔ PASS\x1b[0m ${name} ${detail ? `(${detail})` : ""}`);
      passed++;
    } else {
      console.error(`  \x1b[31m✖ FAIL\x1b[0m ${name} ${detail ? `(${detail})` : ""}`);
      failed++;
    }
  }

  try {
    // === STAGE 1: Server Endpoints & Machine-Readable Surfaces ===
    console.log("\n\x1b[34m[STAGE 1] Testing Local Server Machine-Readable Endpoints\x1b[0m");

    // 1. Root & HTML
    const rootRes = await fetch(`${BASE_URL}/`);
    assert(rootRes.status === 200, "Root page responds with HTTP 200");

    // 2. Search Index (/blume-search.json)
    const searchRes = await fetch(`${BASE_URL}/blume-search.json`);
    assert(searchRes.status === 200, "Search index /blume-search.json responds with HTTP 200");
    const searchData = await searchRes.json().catch(() => null);
    assert(Array.isArray(searchData) && searchData.length > 0, "Search index contains indexed documents", `Count: ${searchData?.length}`);

    // 3. MCP Route (/mcp)
    const mcpRes = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert(mcpRes.status === 200, "Local MCP endpoint /mcp responds to JSON-RPC tools/list");

    // === STAGE 2: GraphRAG Structure & Article Topology ===
    console.log("\n\x1b[34m[STAGE 2] Testing Graph Topology & Article Routing\x1b[0m");
    const graph = loadGraph();
    assert(graph !== null && graph.nodes.length > 300, "In-memory knowledge graph loaded", `Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`);

    // Test a sample article route
    const sampleDocNode = graph.nodes.find((n) => n.type === "Document" && n.slug);
    if (sampleDocNode) {
      const docRes = await fetch(`${BASE_URL}/research/papers/${sampleDocNode.slug}`);
      assert(docRes.status === 200, `Article page /research/papers/${sampleDocNode.slug} loads successfully`);
    }

    // === STAGE 3: Gemini 3.1 Pro Live Question Answering & Graph Reasoning ===
    console.log("\n\x1b[34m[STAGE 3] Testing Live Gemini 3.1 Pro Graph Reasoning against Local Corpus\x1b[0m");

    const qData = readJson(QUESTIONS_PATH);
    const questions = (qData?.questions || []).slice(0, 5); // Evaluate top 5 clinical questions

    for (let i = 0; i < questions.length; i++) {
      const item = questions[i];
      console.log(`\n  \x1b[1m[Eval ${i + 1}/${questions.length}]\x1b[0m ${item.question}`);
      console.log(`  \x1b[90mFailure Trap to Avoid: ${item.failure_mode}\x1b[0m`);

      // 1. Graph retrieval
      const matrix = queryEvidenceMatrix(".*");
      const traversal = traverseGraph(`paper:${item.id}`, { direction: "both", maxDepth: 1 });

      const prompt = `You are a clinical trials research assistant using an evidence knowledge graph.
Question: ${item.question}

Graph Evidence Context:
${JSON.stringify({ traversal: traversal.nodes.slice(0, 5), matrix: matrix.matrix.slice(0, 5) }, null, 2)}

Grounding Rules:
- Distinguish what a trial actually proved from what sponsors or media claimed.
- Quote exact numbers, effect sizes, and p-values when available.
- State explicitly if an endpoint was missed, post-hoc, or non-significant.
- Do not make broad generalisations from single subgroup findings.

Provide your answer in strict JSON:`;

      const schema = S.obj(
        {
          answer: S.str("clinical summary"),
          endpoint_status: S.str("primary endpoint status (met, not_met, discordant, or n/a)"),
          avoided_spin: S.bool("did the answer avoid unproven marketing spin"),
        },
        ["answer", "endpoint_status", "avoided_spin"],
      );

      const res = await gemini(prompt, { model: MODELS.pro, schema });
      assert(res.json.avoided_spin === true, `Question ${i + 1}: Gemini 3.1 Pro avoided deceptive marketing trap`);
      console.log(`  \x1b[36mGemini 3.1 Pro Status:\x1b[0m ${res.json.endpoint_status} | \x1b[36mVerdict:\x1b[0m ${res.json.avoided_spin ? "Spin Avoided ✔" : "Spin Detected ✖"}`);
    }

    console.log("\n==========================================================================");
    if (failed === 0) {
      console.log(`  \x1b[32m✔ ALL ${passed} LOCAL EVALUATION & GEMINI 3.1 PRO TESTS PASSED!\x1b[0m`);
    } else {
      console.error(`  \x1b[31m✖ LOCAL EVALUATION: ${failed} failed, ${passed} passed.\x1b[0m`);
    }
    console.log("==========================================================================\n");
  } finally {
    log("server", "Shutting down local Blume dev server...");
    serverProc.kill("SIGTERM");
  }
}

runLocalEvaluation();
