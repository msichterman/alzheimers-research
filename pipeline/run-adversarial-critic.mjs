#!/usr/bin/env node
// Adversarial Code & Architecture Critic (powered by Gemini 3.1 Pro Preview)
// Reviews the GraphRAG implementation, configuration presets, query engines,
// and evals with harsh scientific and software engineering standards.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_AVAILABLE, MODELS, S, gemini } from "./gemini.mjs";
import { ROOT, log } from "./lib.mjs";

if (!GEMINI_AVAILABLE) {
  console.error("Vertex AI credentials not available.");
  process.exit(1);
}

const filesToReview = [
  "config/preset-graphrag.ts",
  "config/define-research-config.ts",
  "pipeline/build-graph.mjs",
  "pipeline/graph-query.mjs",
  "pipeline/eval-graphrag.mjs",
  "pipeline/eval-gemini-gauntlet.mjs",
];

const fileContents = filesToReview
  .map((file) => {
    const p = join(ROOT, file);
    return `### File: ${file}\n\`\`\`typescript\n${readFileSync(p, "utf8")}\n\`\`\``;
  })
  .join("\n\n");

const prompt = `You are an elite, uncompromising Principal Systems Architect and Clinical Bioinformatician.
Critique the following GraphRAG, Blume Configuration, and Evaluation codebase written for an Alzheimer's Disease clinical research repository.

Be HARSH and thorough. Find all edge cases, performance bottlenecks, schema inconsistencies, missing error handling, and scientific fidelity gaps.

Files Under Review:
${fileContents}

Output your critique in strict JSON:
1. "critical_issues": Array of high-severity flaws or bugs that must be fixed before production.
2. "improvements": Array of medium-severity architectural or performance optimizations.
3. "scientific_fidelity_score": Score 0-100 for evidentiary and statistical rigor.
4. "production_readiness_verdict": "APPROVED_WITH_FIXES", "REJECTED", or "PRODUCTION_READY".
5. "actionable_remediations": List of exact code changes needed.`;

const schema = S.obj(
  {
    critical_issues: S.arr(S.str(), "high severity bugs or flaws"),
    improvements: S.arr(S.str(), "architectural optimizations"),
    scientific_fidelity_score: S.int("score 0-100"),
    production_readiness_verdict: S.str("verdict"),
    actionable_remediations: S.arr(S.str(), "exact fixes"),
  },
  ["critical_issues", "improvements", "scientific_fidelity_score", "production_readiness_verdict", "actionable_remediations"],
);

log("critic", "Running Gemini 3.1 Pro Adversarial Critic...");
const result = await gemini(prompt, { model: MODELS.pro, schema });

console.log("\n==========================================================================");
console.log("  🛑 GEMINI 3.1 PRO ADVERSARIAL CRITIC REPORT");
console.log("==========================================================================");
console.log(`Verdict: ${result.json.production_readiness_verdict}`);
console.log(`Scientific Fidelity Score: ${result.json.scientific_fidelity_score} / 100\n`);

console.log("Critical Issues:");
if (result.json.critical_issues.length === 0) {
  console.log("  (None detected)");
} else {
  result.json.critical_issues.forEach((issue, idx) => console.log(`  ${idx + 1}. ❌ ${issue}`));
}

console.log("\nActionable Remediations & Improvements:");
result.json.actionable_remediations.forEach((item, idx) => console.log(`  ${idx + 1}. 🔧 ${item}`));
console.log("==========================================================================\n");
