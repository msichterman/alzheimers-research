#!/usr/bin/env node
// The utility gate: a blind A/B between the corpus and the primary sources.
//
// For each question, two answers are produced:
//
//   CORPUS   answered from the corpus's structured evidence records only —
//            no full text, exactly what a retrieval agent would see.
//   PRIMARY  answered from the retrieved primary documents themselves, full
//            text, no corpus structure at all.
//
// Both arms use the same model, because the variable under test is the source
// material, not the reader. The primary arm is deliberately given the documents
// rather than made to find them, which is generous to it: if the corpus wins
// anyway, the corpus is adding something real.
//
// The two answers are labelled A and B in an order derived from the question id,
// and a third call — which is told nothing about either pipeline — picks the
// better answer and names the single largest gap in the loser. When the corpus
// loses, that gap is the next builder task.
//
// Output: pipeline/corpus/rounds.json (appended), which the progress page reads.
//
// Usage: node pipeline/ab-eval.mjs [--cluster <name>] [--round <n>] [--focus "<text>"]
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_AVAILABLE, MODELS, S, gemini } from "./gemini.mjs";
import { ENRICHED_DIR, RAW_DIR, ROOT, log, mapLimit, readJson, writeJson } from "./lib.mjs";

const CORPUS_DIR = join(ROOT, "pipeline", "corpus");
const ROUNDS = join(CORPUS_DIR, "rounds.json");

if (!GEMINI_AVAILABLE) {
  log(null, "GOOGLE_AI_API_KEY not set — cannot run the blind A/B");
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyCluster = arg("--cluster");
const focus = arg("--focus") ?? "";

const questions = readJson(join(CORPUS_DIR, "questions.json")).questions.filter(
  (q) => !onlyCluster || q.cluster === onlyCluster,
);
const acquired = readJson(join(CORPUS_DIR, "acquired.json"))?.records ?? {};
const targets = Object.fromEntries((readJson(join(CORPUS_DIR, "targets.json"))?.targets ?? []).map((t) => [t.id, t]));

const PRIMARY_CHAR_BUDGET = 700000;
const CORPUS_CHAR_BUDGET = 700000;

/** Records in a cluster that actually have an evidence record. */
function recordsFor(cluster) {
  return Object.keys(acquired)
    .filter((id) => targets[id]?.cluster === cluster || acquired[id]?.cluster === cluster)
    .map((id) => ({
      id,
      final: readJson(join(ENRICHED_DIR, id, "09-record.json")),
      builder: readJson(join(ENRICHED_DIR, id, "05-evidence.json")),
      rawPath: join(RAW_DIR, id, "document.md"),
    }))
    .filter((r) => r.final || r.builder);
}

/**
 * The corpus arm sees the structured record and nothing else — the same view a
 * retrieval agent gets from the published pages.
 */
function corpusContext(records) {
  let used = 0;
  const parts = [];
  for (const record of records) {
    const body = JSON.stringify(record.final?.record ?? record.builder, null, 1);
    if (used + body.length > CORPUS_CHAR_BUDGET) continue;
    used += body.length;
    parts.push(`### corpus record: ${record.id}\n\n${body}`);
  }
  return parts.join("\n\n");
}

/** The primary arm sees the retrieved documents in full. */
function primaryContext(records) {
  let used = 0;
  const parts = [];
  for (const record of records) {
    if (!existsSync(record.rawPath)) continue;
    const body = readFileSync(record.rawPath, "utf8");
    const slice = body.slice(0, Math.max(0, Math.min(body.length, PRIMARY_CHAR_BUDGET - used)));
    if (slice.length < 500) continue;
    used += slice.length;
    parts.push(`### retrieved document: ${record.id}\n\n${slice}`);
  }
  return parts.join("\n\n");
}

const ANSWER_RULES = `Answer the question directly and completely. Rules:
- Ground every claim in the material provided. Do not use outside knowledge.
- Give specific numbers, endpoints and trial names where the material supports them.
- Distinguish what was prespecified from what was post hoc or a subgroup.
- Say plainly when a primary endpoint was missed; do not soften it.
- Where authoritative sources disagree, present both positions attributed to their sources rather than merging them.
- If the material does not answer part of the question, say so explicitly instead of filling the gap.
- Be concise: at most roughly 400 words.`;

const VERDICT_SCHEMA = S.obj(
  {
    winner: S.str("A or B — which answer is better"),
    margin: S.str("decisive, clear, or narrow"),
    reasoning: S.str("two or three sentences on why the winner is better"),
    largest_gap_in_loser: S.str("the single largest gap in the losing answer, stated concretely enough to act on"),
    factual_errors_in_a: S.arr(S.str("a specific factual error in answer A"), "errors in A"),
    factual_errors_in_b: S.arr(S.str("a specific factual error in answer B"), "errors in B"),
  },
  ["winner", "margin", "reasoning", "largest_gap_in_loser"],
);

/** Side assignment from the question id, so neither arm is systematically A. */
const corpusIsA = (id) => createHash("sha256").update(id).digest()[0] % 2 === 0;

log(null, `blind A/B over ${questions.length} question(s) using ${MODELS.pro}`);

const results = await mapLimit(questions, 3, async (question) => {
  const records = recordsFor(question.cluster);
  if (records.length === 0) {
    return { question, skipped: "no evidence records in this cluster yet" };
  }
  const corpusMaterial = corpusContext(records);
  const primaryMaterial = primaryContext(records);
  if (!corpusMaterial || !primaryMaterial) {
    return { question, skipped: "one arm had no material" };
  }

  const [corpusAnswer, primaryAnswer] = await Promise.all([
    gemini(
      `You are answering a question about Alzheimer's disease research using a structured evidence corpus.\n\n${ANSWER_RULES}\n\nQUESTION: ${question.question}\n\n--- CORPUS RECORDS ---\n\n${corpusMaterial}`,
      { model: MODELS.pro, maxOutputTokens: 4096 },
    ),
    gemini(
      `You are answering a question about Alzheimer's disease research by reading primary source documents directly.\n\n${ANSWER_RULES}\n\nQUESTION: ${question.question}\n\n--- RETRIEVED PRIMARY DOCUMENTS ---\n\n${primaryMaterial}`,
      { model: MODELS.pro, maxOutputTokens: 4096 },
    ),
  ]);

  const swap = corpusIsA(question.id);
  const answerA = swap ? corpusAnswer.text : primaryAnswer.text;
  const answerB = swap ? primaryAnswer.text : corpusAnswer.text;

  const verdict = await gemini(
    `You are evaluating two answers to the same question about Alzheimer's disease research.

You know nothing about how either answer was produced, and you must not speculate about it. Judge only the answers.

What makes an answer better, in order:
1. Factual accuracy against what the trials and documents actually reported.
2. Correctly separating prespecified results from post-hoc and subgroup results.
3. Stating plainly when a primary endpoint was missed, rather than softening it.
4. Covering negative and failed programmes, not only successful ones.
5. Presenting genuine disagreement between authoritative sources as disagreement, attributed, rather than resolving it into one verdict.
6. Admitting what it does not know instead of filling the gap.

Length and polish do not count. A shorter answer that is right and honest beats a longer one that is confident and incomplete.

QUESTION: ${question.question}

--- ANSWER A ---
${answerA}

--- ANSWER B ---
${answerB}`,
    { model: MODELS.pro, schema: VERDICT_SCHEMA, maxOutputTokens: 4096 },
  );

  const winnerLetter = String(verdict.json?.winner ?? "").trim().toUpperCase().startsWith("A") ? "A" : "B";
  const winner = (winnerLetter === "A") === swap ? "corpus" : "primary-sources";

  return {
    question,
    winner,
    margin: verdict.json?.margin ?? null,
    reasoning: verdict.json?.reasoning ?? null,
    largest_gap: verdict.json?.largest_gap_in_loser ?? null,
    errors_in_corpus_answer: swap ? (verdict.json?.factual_errors_in_a ?? []) : (verdict.json?.factual_errors_in_b ?? []),
    errors_in_primary_answer: swap ? (verdict.json?.factual_errors_in_b ?? []) : (verdict.json?.factual_errors_in_a ?? []),
    records_in_scope: records.length,
    corpus_answer: swap ? answerA : answerB,
    primary_answer: swap ? answerB : answerA,
  };
});

const verdicts = [];
for (const result of results) {
  if (result.error) {
    log(null, `A/B FAILED: ${result.error.message}`);
    continue;
  }
  const r = result.value;
  if (r.skipped) {
    log(r.question.id, `skipped — ${r.skipped}`);
    continue;
  }
  verdicts.push({
    question_id: r.question.id,
    cluster: r.question.cluster,
    required: Boolean(r.question.required),
    question: r.question.question,
    winner: r.winner,
    margin: r.margin,
    reasoning: r.reasoning,
    largest_gap: r.largest_gap,
    errors_in_corpus_answer: r.errors_in_corpus_answer,
    records_in_scope: r.records_in_scope,
    corpus_answer: r.corpus_answer,
    primary_answer: r.primary_answer,
  });
  log(r.question.id, `${r.winner === "corpus" ? "CORPUS WINS" : "primary sources win"} (${r.margin}) — gap: ${String(r.largest_gap).slice(0, 110)}`);
}

const existing = readJson(ROUNDS) ?? { rounds: [] };
const roundNumber = Number(arg("--round") ?? existing.rounds.length + 1);
// The next builder tasks are the gaps named where the corpus lost.
const nextTasks = verdicts
  .filter((v) => v.winner !== "corpus")
  .map((v) => `[${v.cluster}] ${v.largest_gap}`);

existing.rounds.push({
  round: roundNumber,
  started_at: new Date().toISOString(),
  focus,
  cluster: onlyCluster ?? "all",
  model: MODELS.pro,
  questions_run: verdicts.length,
  corpus_wins: verdicts.filter((v) => v.winner === "corpus").length,
  ab_verdicts: verdicts.map(({ corpus_answer, primary_answer, ...rest }) => rest),
  next_builder_tasks: nextTasks,
});
writeJson(ROUNDS, existing);
writeJson(join(CORPUS_DIR, `round-${roundNumber}-answers.json`), { round: roundNumber, verdicts });

const wins = verdicts.filter((v) => v.winner === "corpus").length;
log(null, `round ${roundNumber}: corpus won ${wins}/${verdicts.length}`);
for (const task of nextTasks) log(null, `  next builder task: ${task.slice(0, 160)}`);
