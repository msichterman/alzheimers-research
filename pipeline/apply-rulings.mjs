#!/usr/bin/env node
// Produce the final record: the builder's extraction with every adjudicated
// conflict resolved the way the adjudicator ruled.
//
// The builder's file is never edited. 05-evidence.json stays exactly as the
// builder wrote it, 06-critique.json stays as the critic wrote it, and this
// stage writes a third file, 09-record.json, that carries the resolved values
// plus a note of what changed and why. That is what publishing reads. Keeping
// all three means a disagreement is always inspectable after the fact, rather
// than being overwritten by whoever ran last.
//
// A ruling of "neither" nulls the field: if the adjudicator could not find
// support for either reading in the document, the record does not get to keep a
// value.
//
// Usage: node pipeline/apply-rulings.mjs [id...]
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENRICHED_DIR, log, readJson, writeJson } from "./lib.mjs";

const onlyIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));

/** Set a dotted path like "study.n.value" or "outcomes[primary].met". */
function applyToRecord(record, field, value) {
  const primaryOutcome = () => (record.outcomes ?? []).filter((o) => o.tier === "primary");

  if (field.startsWith("outcomes[primary].")) {
    const key = field.slice("outcomes[primary].".length);
    const outcomes = primaryOutcome();
    if (outcomes.length === 0) return false;
    // Only rewrite when there is a single primary outcome; a trial reporting two
    // co-primaries needs the adjudicator to name which one, so it is left for a
    // human rather than guessed at.
    if (outcomes.length > 1) return "ambiguous";
    outcomes[0][key] = value;
    return true;
  }
  if (field.startsWith("safety.harms[")) {
    // Harm rulings are advisory: they say whether a harm is reported, not which
    // of many entries to rewrite. Recorded in the changelog, not applied blind.
    return "advisory";
  }
  if (field.startsWith("outcomes[") && field.includes("].")) {
    const name = field.slice("outcomes[".length, field.lastIndexOf("]."));
    const key = field.slice(field.lastIndexOf("].") + 2);
    const match = (record.outcomes ?? []).find((o) => o.name === name);
    if (!match) return false;
    match[key] = value;
    return true;
  }
  const path = field.split(".");
  let node = record;
  for (const segment of path.slice(0, -1)) {
    if (node === null || node === undefined) return false;
    node = node[segment];
  }
  if (node === null || node === undefined) return false;
  const last = path[path.length - 1];
  // Wrapped values keep their quote and location; only the value changes.
  if (node[last] && typeof node[last] === "object" && "value" in node[last]) node[last].value = value;
  else node[last] = value;
  return true;
}

const ids = (onlyIds.length > 0 ? onlyIds : readdirSync(ENRICHED_DIR)).filter((id) =>
  existsSync(join(ENRICHED_DIR, id, "05-evidence.json")),
);

let written = 0;
for (const id of ids) {
  const builder = readJson(join(ENRICHED_DIR, id, "05-evidence.json"));
  const adjudication = readJson(join(ENRICHED_DIR, id, "08-adjudication.json"));
  // Read the same set that was sent for adjudication, so the two never drift:
  // conflicts.json is what a blind reader was actually shown.
  const blinded = readJson(join(ENRICHED_DIR, id, "conflicts.json"));
  const fidelity = readJson(join(ENRICHED_DIR, id, "07-fidelity.json"));
  const conflicts = blinded?.conflicts ?? fidelity?.conflict_rows ?? [];

  const record = structuredClone(builder);
  const changelog = [];
  const unresolved = [];
  const needsManualApply = [];

  for (const conflict of conflicts) {
    const ruling = (adjudication?.rulings ?? []).find((r) => r.field === conflict.field);
    if (!ruling) {
      unresolved.push({ field: conflict.field, reason: "no adjudicator ruling for this conflict" });
      continue;
    }
    const value = ruling.verdict === "neither" ? null : ruling.correct_value;
    const applied = applyToRecord(record, conflict.field, value);
    changelog.push({
      field: conflict.field,
      verdict: ruling.verdict,
      resolved_value: value,
      applied: applied === true,
      disposition:
        applied === true
          ? "applied"
          : applied === "advisory"
            ? "advisory only — harm entries are not rewritten from a presence ruling"
            : applied === "ambiguous"
              ? "not applied — more than one primary outcome, so the ruling does not identify which to change"
              : "not applied — field path not present in the record",
      quote: ruling.quote ?? null,
      reasoning: ruling.reasoning ?? null,
    });
    // A ruling exists, so the conflict is settled — a blind reader went to the
    // document and decided. What "not applied" means is that the automation will
    // not rewrite the record from it: a presence verdict does not tell you which
    // of eighty harm entries to edit, and a co-primary ruling does not say which
    // of two primary outcomes it refers to. Those are flagged for a human to
    // apply by hand rather than guessed at, and they are not a gate failure.
    if (applied !== true) needsManualApply.push({ field: conflict.field, verdict: ruling.verdict, resolved_value: value, reason: changelog[changelog.length - 1].disposition });
  }

  writeJson(join(ENRICHED_DIR, id, "09-record.json"), {
    id,
    built_at: new Date().toISOString(),
    derived_from: {
      builder: "enriched/<id>/05-evidence.json",
      independent_critic: "enriched/<id>/06-critique.json",
      fidelity_diff: "enriched/<id>/07-fidelity.json",
      adjudication: adjudication ? "enriched/<id>/08-adjudication.json" : null,
    },
    conflicts_found: conflicts.length,
    conflicts_ruled: changelog.length,
    conflicts_unresolved: unresolved.length,
    conflicts_needing_manual_apply: needsManualApply.length,
    adjudication_changelog: changelog,
    unresolved,
    needs_manual_apply: needsManualApply,
    record,
  });
  written++;
  log(
    id,
    `09-record.json written — ${changelog.length}/${conflicts.length} conflicts ruled, ${unresolved.length} unruled, ${needsManualApply.length} awaiting manual application`,
  );
}
log(null, `apply-rulings complete: ${written} record(s)`);
