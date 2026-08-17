// Temp helper: verify every `quote` in an evidence JSON is a verbatim substring
// of the source document, and check word counts are within 10-40.
import { readFileSync } from "node:fs";

const id = process.argv[2];
const doc = readFileSync(`raw/${id}/document.md`, "utf8");
const rec = JSON.parse(readFileSync(`enriched/${id}/05-evidence.json`, "utf8"));

let bad = 0, n = 0;
const walk = (node, path) => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    if ((k === "quote" || k === "prespecification_evidence") && typeof v === "string") {
      n++;
      const words = v.trim().split(/\s+/).length;
      if (!doc.includes(v)) {
        bad++;
        console.log(`NOT FOUND  ${p}: ${JSON.stringify(v.slice(0, 120))}`);
      } else if (words < 10 || words > 40) {
        bad++;
        console.log(`WORDCOUNT ${words}  ${p}: ${JSON.stringify(v.slice(0, 90))}`);
      }
    } else {
      walk(v, p);
    }
  }
};
walk(rec, "");
console.log(`${id}: checked ${n} quotes, ${bad} problems`);
