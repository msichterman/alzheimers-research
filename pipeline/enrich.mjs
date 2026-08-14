#!/usr/bin/env node
// Run the agent stages over parsed documents in raw/, writing JSON to enriched/<id>/.
//   01-analysis   critic: metadata, tags, themes, claims, red flags
//   02-trials     clinical-trials researcher: registry-verified evidence record
//   03-sentiment  public-sentiment researcher: reddit/media/investor perception
//   04-review     final reviewer: fact-check + page content + timeline entries
// Stages 02 and 03 run in parallel after 01; 04 runs last. Documents run
// concurrently (PIPELINE_CONCURRENCY, default 2). Idempotent per stage against
// the source hash; use --force or --stage <nn-name> to redo work.
// Usage: pnpm enrich [id...] [--stage 02-trials] [--force]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONCURRENCY,
  DOCS_DIR,
  ENRICHED_DIR,
  MODEL,
  listRawDocs,
  listSitePages,
  log,
  mapLimit,
  readJson,
  renderPrompt,
  runAgent,
  writeJson,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const stageIndex = argv.indexOf("--stage");
const onlyStage = stageIndex >= 0 ? argv[stageIndex + 1] : null;
const onlyIds = argv.filter(
  (a, i) => !a.startsWith("--") && (stageIndex === -1 || i !== stageIndex + 1),
);

const TODAY = new Date().toISOString().slice(0, 10);
const STAGES = ["01-analysis", "02-trials", "03-sentiment", "04-review"];

const docs = listRawDocs(onlyIds);
if (docs.length === 0) {
  log(null, "nothing to enrich — run `pnpm parse` first");
  process.exit(0);
}
if (onlyStage && !STAGES.includes(onlyStage)) {
  console.error(`--stage must be one of: ${STAGES.join(", ")}`);
  process.exit(1);
}

log(null, `enriching ${docs.length} doc(s) with model=${MODEL}, concurrency=${CONCURRENCY}`);

async function runStage(doc, stage, values) {
  const dir = join(ENRICHED_DIR, doc.id);
  const statePath = join(dir, "state.json");
  const outPath = join(dir, `${stage}.json`);
  const state = readJson(statePath, {});
  const cached = readJson(outPath);
  const fresh = cached && state[stage]?.source_sha256 === doc.meta.sha256;

  if (onlyStage && stage !== onlyStage) {
    // Targeting one stage: everything else feeds from cache.
    if (cached) return cached;
    throw new Error(`${stage} output missing but required — run pnpm enrich without --stage first`);
  }
  const mustRun = force || onlyStage === stage;
  if (!mustRun && fresh) {
    log(doc.id, `${stage}: up to date, skipping`);
    return cached;
  }

  log(doc.id, `${stage}: running...`);
  const prompt = renderPrompt(`${stage}.md`, { TODAY, ...values });
  const { payload, envelope } = await runAgent(prompt, {
    id: doc.id,
    stage,
    logPath: join(dir, "logs", `${stage}.log`),
  });
  writeJson(outPath, payload);
  state[stage] = {
    source_sha256: doc.meta.sha256,
    completed_at: new Date().toISOString(),
    model: MODEL,
    turns: envelope.num_turns,
    cost_usd: envelope.total_cost_usd,
    session_id: envelope.session_id,
  };
  writeJson(statePath, state);
  return payload;
}

const results = await mapLimit(docs, CONCURRENCY, async (doc) => {
  const documentMarkdown = readFileSync(doc.markdownPath, "utf8");
  const common = {
    DOCUMENT_MARKDOWN: documentMarkdown,
    SOURCE_PATH: doc.meta.source,
  };

  const analysis = await runStage(doc, "01-analysis", common);
  const analysisJson = JSON.stringify(analysis, null, 2);

  const trials = await runStage(doc, "02-trials", { ANALYSIS_JSON: analysisJson });
  const sentiment = await runStage(doc, "03-sentiment", { ANALYSIS_JSON: analysisJson });

  const timelineTitles = [
    ...readFileSync(join(DOCS_DIR, "timeline", "index.mdx"), "utf8").matchAll(
      /<Step title="([^"]+)"/g,
    ),
  ]
    .map((m) => `- ${m[1]}`)
    .join("\n");

  await runStage(doc, "04-review", {
    ...common,
    ANALYSIS_JSON: analysisJson,
    TRIALS_JSON: JSON.stringify(trials, null, 2),
    SENTIMENT_JSON: JSON.stringify(sentiment, null, 2),
    SITE_PAGES: listSitePages()
      .map((p) => `- ${p.route} — ${p.title}`)
      .join("\n"),
    TIMELINE_TITLES: timelineTitles || "- (none yet)",
  });
  return doc.id;
});

let failed = 0;
results.forEach((result, i) => {
  if (result.error) {
    failed++;
    log(docs[i].id, `FAILED: ${result.error.message}`);
  }
});

const spent = docs
  .map((d) => readJson(join(ENRICHED_DIR, d.id, "state.json"), {}))
  .flatMap((s) => Object.values(s))
  .reduce((sum, st) => sum + (st.cost_usd || 0), 0);
log(null, `enrich complete: ${docs.length - failed}/${docs.length} ok, total spend ~$${spent.toFixed(2)}`);
if (failed > 0) {
  log(null, "re-run `pnpm enrich` to retry failed stages (completed stages are cached)");
  process.exit(1);
}
