#!/usr/bin/env node
// Prepare conflicts for blind adjudication.
//
// When the builder and the independent critic assert incompatible things, a
// third reader settles it against the document. That reader must not be able to
// tell which extraction came from which pipeline — otherwise it is not
// adjudicating, it is deferring. So each conflict is written out with the two
// readings labelled A and B in an order that depends on the record and field
// rather than on which pipeline produced them, and the key is stored separately.
//
// Writes enriched/<id>/conflicts.json (blinded, for the adjudicator) and
// enriched/<id>/conflicts.key.json (the mapping, for scoring afterwards).
//
// Usage: node pipeline/blind-conflicts.mjs [id...]
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENRICHED_DIR, log, readJson, writeJson } from "./lib.mjs";

const onlyIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));

/**
 * Deterministic but content-derived side assignment. Using a hash of the record
 * id and field name means the builder is not systematically "A", so an
 * adjudicator that develops a positional preference cannot express it as a
 * preference for one pipeline.
 */
const builderIsA = (id, field) =>
  createHash("sha256").update(`${id}:${field}`).digest()[0] % 2 === 0;

const ids = (onlyIds.length > 0 ? onlyIds : readdirSync(ENRICHED_DIR)).filter((id) =>
  existsSync(join(ENRICHED_DIR, id, "07-fidelity.json")),
);

let total = 0;
for (const id of ids) {
  const fidelity = readJson(join(ENRICHED_DIR, id, "07-fidelity.json"));
  // Critical coverage gaps go to adjudication as well: "one extraction found a
  // confidence interval here and the other found nothing" is exactly the kind of
  // question a third reader settles by looking.
  const conflicts = [
    ...(fidelity.conflict_rows ?? []),
    ...(fidelity.all_rows ?? []).filter((r) => r.kind === "coverage-gap" && r.critical),
  ];
  if (conflicts.length === 0) continue;

  const blinded = [];
  const key = [];
  conflicts.forEach((row, index) => {
    const swap = builderIsA(id, row.field);
    const a = swap ? row.builder : row.critic;
    const b = swap ? row.critic : row.builder;
    blinded.push({
      conflict_id: `${id}#${index}`,
      field: row.field,
      reading_a: a,
      reading_b: b,
      note: row.kind === "coverage-gap" ? "One reading found nothing here. Decide whether the document actually states this; 'neither' is correct if it does not." : null,
    });
    key.push({ conflict_id: `${id}#${index}`, field: row.field, a_is: swap ? "builder" : "critic", b_is: swap ? "critic" : "builder" });
  });

  writeJson(join(ENRICHED_DIR, id, "conflicts.json"), {
    id,
    prepared_at: new Date().toISOString(),
    instructions:
      "Two independent extractions of the same retrieved document disagree on these fields. For each conflict, decide against the document which reading is correct — or that both are, or neither is. You are not told which pipeline produced which reading, and you must not guess.",
    conflicts: blinded,
  });
  writeJson(join(ENRICHED_DIR, id, "conflicts.key.json"), { id, key });
  total += blinded.length;
  log(id, `${blinded.length} conflict(s) blinded for adjudication`);
}
log(null, `blind-conflicts complete: ${total} conflict(s) across ${ids.length} record(s)`);
