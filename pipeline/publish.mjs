#!/usr/bin/env node
// Render reviewed content (enriched/<id>/04-review.json) into the Blume site:
//   docs/research/<slug>.mdx     paper note (template-conformant)
//   docs/trials/<slug>.mdx       trial pages for trials central to the document
//   docs/timeline/index.mdx      milestone entries, date-ordered, deduped
// Deterministic renderer: agents supply content, this script owns structure.
// Usage: pnpm publish:docs [id...]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCS_DIR,
  ENRICHED_DIR,
  ensureDir,
  listRawDocs,
  log,
  mdxSafe,
  readJson,
  slugify,
  writeJson,
  yamlString,
} from "./lib.mjs";

const PAPERS_DIR = join(DOCS_DIR, "research", "papers");

/** "2026-04" | "2026" -> { iso: "2026-04-01", key: 202604, label: "2026-04" } */
function normalizeDate(published) {
  const m = String(published ?? "").match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return null;
  const month = m[2] ?? "01";
  return {
    iso: `${m[1]}-${month}-01`,
    key: Number(m[1]) * 100 + Number(month),
    label: m[2] ? `${m[1]}-${m[2]}` : m[1],
  };
}

const onlyIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const docs = listRawDocs(onlyIds);

const frontmatter = (fields, tags, extra = []) =>
  [
    "---",
    `title: ${yamlString(fields.title)}`,
    `description: ${yamlString(fields.description)}`,
    ...extra,
    "search:",
    `  tags: [${tags.map((t) => slugify(t)).filter(Boolean).join(", ")}]`,
    "---",
  ].join("\n");

const bullets = (items = []) => items.map((item) => `- ${mdxSafe(item)}`).join("\n");

/**
 * Author records, normalized. Stage 1 emits objects, but older enriched JSON
 * (and a model that ignores the schema) may still carry plain name strings —
 * accept both so a re-publish of an old document doesn't drop its credits.
 */
const authorRecords = (analysis) =>
  (analysis?.authors ?? [])
    .map((a) => (typeof a === "string" ? { name: a } : a))
    .filter((a) => a && typeof a.name === "string" && a.name.trim() !== "");

/** Licence as extracted, defaulting to the honest "unknown" rather than open. */
const licenseInfo = (analysis) => {
  const l = analysis?.license ?? {};
  return {
    name: typeof l.name === "string" && l.name.trim() ? l.name.trim() : "unknown",
    url: typeof l.url === "string" && l.url.startsWith("http") ? l.url : null,
    reuse: typeof l.reuse === "string" ? l.reuse : "unknown",
  };
};

/** "Ryder, M. I. Title. *Venue*; 2020. doi:10.xxxx/yyy" — one canonical citation. */
function citation(analysis) {
  const names = authorRecords(analysis).map((a) => a.name);
  const byline =
    names.length === 0
      ? (analysis?.first_author ?? "Unknown author")
      : names.length > 3
        ? `${names[0]} et al.`
        : names.join("; ");
  const parts = [
    // Initials already end in a period ("Ryder M.I."), so don't double it.
    `${mdxSafe(byline).replace(/\.$/, "")}.`,
    analysis?.title ? `${mdxSafe(analysis.title)}.` : null,
    analysis?.venue ? `*${mdxSafe(analysis.venue)}*` : null,
    analysis?.published ? `${mdxSafe(String(analysis.published))}.` : null,
    analysis?.doi ? `doi:${mdxSafe(analysis.doi)}` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * The attribution block every generated page carries. Both current sources are
 * CC BY, which *requires* credit to the author, a link to the licence, and a
 * statement of what was changed — so the renderer emits all three rather than
 * leaving it to whoever writes the page. Contact details are reproduced only
 * as the source document published them (see the extraction prompt).
 */
function renderAttribution(analysis, { sourceFile, parsedAt } = {}) {
  if (!analysis) return "";
  const authors = authorRecords(analysis);
  const license = licenseInfo(analysis);
  const licenseText = license.url
    ? `[${mdxSafe(license.name)}](${license.url})`
    : mdxSafe(license.name);

  const authorRows = authors.map((a) => {
    const contact = [
      a.orcid ? `[ORCID](${a.orcid})` : null,
      a.email ? `[${mdxSafe(a.email)}](mailto:${a.email})` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `| ${tableCell(a.name)}${a.corresponding ? " ✉️" : ""} | ${tableCell(a.affiliation)} | ${contact || "—"} | ${tableCell(a.conflicts)} |`;
  });

  const authorTable =
    authorRows.length > 0
      ? [
          "| Author | Affiliation | Contact | Declared conflicts |",
          "| --- | --- | --- | --- |",
          ...authorRows,
          "",
          "*✉️ corresponding author. Affiliations and contact details are reproduced as published in the source document.*",
        ].join("\n")
      : "*Author records were not extractable from the source document.*";

  const links = [
    analysis.doi_url ? `[DOI](${analysis.doi_url})` : null,
    analysis.pubmed_url ? `[PubMed](${analysis.pubmed_url})` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    "\n## Attribution\n",
    `**Cite the original work:** ${citation(analysis)}${links ? ` — ${links}` : ""}\n`,
    analysis.copyright ? `**Copyright:** ${mdxSafe(analysis.copyright)}\n` : "",
    `**Licence:** ${licenseText}${license.reuse === "unknown" ? " — reuse terms unconfirmed; quote sparingly and link the original." : ""}\n`,
    `**Changes made:** this page is a summary with critical commentary written by the [research pipeline](https://github.com/msichterman/alzheimers-research/blob/main/PIPELINE.md)${sourceFile ? ` from \`${sourceFile}\`` : ""}${parsedAt ? ` (parsed ${parsedAt})` : ""}. It is not the original text, and any wording here is the pipeline's unless quoted.\n`,
    `\n${authorTable}\n`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

const section = (title, body) => {
  if (!body || (Array.isArray(body) && body.length === 0)) return "";
  const content = Array.isArray(body) ? bullets(body) : mdxSafe(body);
  return `\n## ${title}\n\n${content}\n`;
};

const tableCell = (value) =>
  mdxSafe(value ?? "—").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

const subsection = (title, body) => {
  if (!body || (Array.isArray(body) && body.length === 0)) return "";
  const content = Array.isArray(body) ? bullets(body) : mdxSafe(body);
  return `\n### ${title}\n\n${content}\n`;
};

/**
 * The cross-examination record, rendered straight from the stage outputs so
 * every report carries the same structured sections: who paid, where the spin
 * is, how strong each claim is, and what the registry/fact-check disputes.
 */
function renderCriticalReview(docId, { analysis, trials, sentiment, factCheck }) {
  const claimsTable =
    (analysis?.key_claims ?? []).length > 0
      ? [
          "| Claim | Evidence strength | Where |",
          "| --- | --- | --- |",
          ...analysis.key_claims.map(
            (c) => `| ${tableCell(c.claim)} | ${tableCell(c.strength)} | ${tableCell(c.location)} |`,
          ),
        ].join("\n")
      : null;

  const flagged = (factCheck ?? []).filter((f) => f.status !== "verified");
  const verifiedCount = (factCheck ?? []).length - flagged.length;
  const crossExam = [
    ...flagged.map(
      (f) => `**Fact check (${f.status})** — ${String(f.fact).replace(/\.$/, "")}. ${f.note}`,
    ),
    ...(trials?.discrepancies ?? []).map((d) => `**Registry cross-check** — ${d}`),
    ...(sentiment?.misinformation_flags ?? []).map((m) => `**Misinformation watch** — ${m}`),
  ];
  const crossExamBody =
    crossExam.length > 0
      ? [
          `${verifiedCount} facts verified against the source document and trial registries. Flagged items:`,
          "",
          bullets(crossExam),
        ].join("\n")
      : (factCheck ?? []).length > 0
        ? `All ${verifiedCount} checked facts verified against the source document and trial registries; no registry discrepancies or misinformation flags.`
        : "";

  const body = [
    `*Cross-examination record extracted by the pipeline's critic, trials, and sentiment agents, plus the reviewer's fact check. Full structured outputs: \`enriched/${docId}/\`.*\n`,
    subsection("Funding & conflicts", analysis?.funding_and_conflicts),
    subsection("Bias & spin flags", analysis?.red_flags),
    claimsTable ? `\n### Claims assessed\n\n${claimsTable}\n` : "",
    subsection("Cross-examination", crossExamBody),
  ]
    .filter((part) => part !== "")
    .join("");
  return body ? `\n## Critical review\n\n${body}` : "";
}

function renderResearchPage(page, provenance, docId, stages, meta) {
  // Publication date drives the papers index and newest-first sidebar order.
  const pubDate = normalizeDate(stages.analysis?.published);
  // `type` and `year` are the content type and facet an agent filters on
  // (see content.types in blume.config.ts); both are declared optional, so a
  // document with no resolvable date still publishes.
  // Attribution metadata rides in frontmatter as well as in the page body, so
  // agents can filter on it (licence and first author are declared facets) and
  // credits survive the Markdown downlevel.
  const analysis = stages.analysis;
  const authors = authorRecords(analysis);
  const license = licenseInfo(analysis);
  const extra = [
    "type: paper",
    ...(pubDate
      ? [
          `date: ${pubDate.iso}`,
          `year: "${pubDate.iso.slice(0, 4)}"`,
          "sidebar:",
          `  order: ${-pubDate.key}`,
        ]
      : []),
    ...(analysis?.doi ? [`doi: ${yamlString(analysis.doi)}`] : []),
    `license: ${yamlString(license.name)}`,
    ...(authors[0] ? [`firstAuthor: ${yamlString(authors[0].name)}`] : []),
    ...(authors.length > 0
      ? [
          "authors:",
          ...authors.flatMap((a) => [
            `  - name: ${yamlString(a.name)}`,
            ...(a.affiliation ? [`    affiliation: ${yamlString(a.affiliation)}`] : []),
            ...(a.orcid ? [`    orcid: ${yamlString(a.orcid)}`] : []),
            ...(a.email ? [`    email: ${yamlString(a.email)}`] : []),
            ...(a.corresponding ? ["    corresponding: true"] : []),
          ]),
        ]
      : []),
  ];
  return [
    frontmatter(page, page.tags ?? ["paper"], extra),
    "",
    mdxSafe(page.source_line_md),
    `**Authors**: ${mdxSafe(page.authors_line_md)}`,
    section("Takeaway", page.takeaway_md),
    section("Key findings", page.key_findings_md),
    section("Methods in brief", page.methods_md),
    section("Trial evidence", page.trial_evidence_md),
    section("Public sentiment", page.sentiment_md),
    section("Caveats", page.caveats_md),
    renderCriticalReview(docId, stages),
    section("Relates to", page.relates_to_md),
    renderAttribution(analysis, {
      sourceFile: meta?.source,
      parsedAt: meta?.parsed_at?.slice(0, 10),
    }),
    "\n---\n",
    `*${provenance}*`,
    "",
  ]
    .filter((part) => part !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The four values `content.types.trial.frontmatter.status` accepts. */
const TRIAL_STATUSES = ["Recruiting", "Active", "Completed", "Terminated"];

/**
 * Facet values are matched exactly, so reduce a drug field like
 * "COR388 / atuzaginstat (gingipain inhibitor)" to the name an agent would
 * filter on. Returns null when there's nothing usable.
 */
const drugFacet = (value) => {
  const name = String(value ?? "")
    .split(/[/(,]/)[0]
    .trim();
  return name.length > 0 && name !== "—" ? name : null;
};

/**
 * Trial pages compile two sources: the public registry record and the source
 * document the pipeline read. Both get credited, and the source document's
 * licence travels with it.
 */
function renderTrialAttribution(analysis, { sourceFile } = {}) {
  const license = licenseInfo(analysis);
  const parts = [
    "Compiled from the trial's public [ClinicalTrials.gov](https://clinicaltrials.gov) registry record",
    analysis
      ? `and ${citation(analysis)}${license.name !== "unknown" ? ` (${license.name})` : ""}`
      : sourceFile
        ? `and \`${sourceFile}\``
        : null,
  ].filter(Boolean);
  return `\n## Attribution\n\n${parts.join(" ")}. Registry data is US government work; the summary and commentary here are the pipeline's.\n`;
}

function renderTrialPage(trial, provenance, meta, analysis) {
  const row = (label, value) => `| **${label}** | ${mdxSafe(value ?? "—")} |`;
  const badge = trial.badge ?? "Active";
  const drug = drugFacet(trial.drug);
  // Content type + facets, mirroring content.types in blume.config.ts. A key
  // whose value doesn't fit the declared schema is left off rather than
  // written out — every facet is optional, and a failed build helps no one.
  const facets = [
    "type: trial",
    ...(TRIAL_STATUSES.includes(badge) ? [`status: ${badge}`] : []),
    ...(trial.phase ? [`phase: ${yamlString(String(trial.phase))}`] : []),
    ...(drug ? [`drug: ${yamlString(drug)}`] : []),
  ];
  return [
    frontmatter(trial, trial.tags ?? ["trial"], [
      ...facets,
      "sidebar:",
      `  badge: ${badge}`,
    ]),
    "",
    "| | |",
    "| --- | --- |",
    row("Registry", trial.registry_md),
    row("Drug", trial.drug),
    row("Phase", trial.phase),
    row("Sponsor", trial.sponsor),
    row("Population", trial.population),
    row("Primary endpoint", trial.primary_endpoint),
    row("Started", trial.started),
    row("Expected readout", trial.readout),
    section("Why it matters", trial.why_md),
    trial.results_md ? section("Results", trial.results_md) : "",
    section("Status log", trial.status_log_md),
    renderTrialAttribution(analysis, { sourceFile: meta?.source }),
    "\n---\n",
    `*${provenance}*`,
    "",
  ]
    .filter((part) => part !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const dateKey = (text) => {
  const m = String(text).match(/^(\d{4})(?:-(\d{2}))?/);
  return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : 999999;
};

function insertTimelineEntry(content, entry) {
  const title = entry.title.replace(/"/g, "'");
  if (content.includes(`title="${title}"`)) {
    return { content, action: "skipped (already present)" };
  }
  const step = `  <Step title="${title}">\n    ${mdxSafe(entry.body_md).replace(/\n/g, "\n    ")}\n  </Step>\n`;

  const heading = `## ${entry.section}`;
  let sectionStart = content.indexOf(heading);
  if (sectionStart === -1) {
    // New section: place before "## Watching" when present, else append.
    const block = `${heading}\n\n<Steps>\n${step}</Steps>\n\n`;
    const watching = content.indexOf("## Watching");
    const insertAt = watching === -1 ? content.length : watching;
    return {
      content: `${content.slice(0, insertAt)}${block}${content.slice(insertAt)}`,
      action: `created section "${entry.section}"`,
    };
  }

  const sectionEnd = content.indexOf("\n## ", sectionStart + heading.length);
  const sectionBody = content.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  const steps = [...sectionBody.matchAll(/[ \t]*<Step title="([^"]+)">[\s\S]*?<\/Step>\n?/g)];
  let insertAt;
  const laterStep = steps.find((m) => dateKey(m[1]) > dateKey(entry.date));
  if (laterStep) {
    insertAt = sectionStart + laterStep.index;
  } else if (steps.length > 0) {
    const last = steps[steps.length - 1];
    insertAt = sectionStart + last.index + last[0].length;
  } else {
    const stepsOpen = sectionBody.indexOf("<Steps>");
    if (stepsOpen === -1) return { content, action: `section "${entry.section}" has no <Steps> block — add manually` };
    insertAt = sectionStart + stepsOpen + "<Steps>\n".length;
  }
  return {
    content: `${content.slice(0, insertAt)}${step}${content.slice(insertAt)}`,
    action: `added to "${entry.section}"`,
  };
}

/** Regenerate the "Tracked trials" table in docs/trials/index.mdx from the trial pages. */
function syncTrialsIndex() {
  const dir = join(DOCS_DIR, "trials");
  const indexPath = join(dir, "index.mdx");
  if (!existsSync(indexPath)) return;
  const rows = readdirSync(dir)
    .filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
    .map((file) => {
      const body = readFileSync(join(dir, file), "utf8");
      const field = (label) =>
        body.match(new RegExp(`\\| \\*\\*${label}\\*\\* \\| (.+?) \\|`))?.[1] ?? "—";
      return {
        slug: file.replace(/\.mdx$/, ""),
        title: body.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? file,
        badge: body.match(/badge:\s*(.+)/)?.[1]?.trim() ?? "—",
        drug: field("Drug").replace(/\s*\(.*$/, ""),
        phase: field("Phase"),
        readout: field("Expected readout").split(";")[0].trim(),
      };
    });
  const order = { Recruiting: 0, Active: 1, Completed: 2, Terminated: 3 };
  rows.sort(
    (a, b) => (order[a.badge] ?? 9) - (order[b.badge] ?? 9) || a.title.localeCompare(b.title),
  );
  const table = [
    "| Trial | Drug | Phase | Status | Readout |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) => `| [${r.title}](/trials/${r.slug}) | ${r.drug} | ${r.phase} | ${r.badge} | ${r.readout} |`,
    ),
  ].join("\n");
  const content = readFileSync(indexPath, "utf8");
  const updated = content.replace(
    /(## Tracked trials\n\n)\|[\s\S]*?\n(\n[^|])/,
    `$1${table}\n$2`,
  );
  if (updated !== content) {
    writeFileSync(indexPath, updated);
    log(null, `synced docs/trials/index.mdx table (${rows.length} trials)`);
  }
}

/** Regenerate the "All papers" table in docs/research/papers/index.mdx, newest first. */
function syncPapersIndex() {
  const indexPath = join(PAPERS_DIR, "index.mdx");
  if (!existsSync(indexPath)) return;
  const rows = readdirSync(PAPERS_DIR)
    .filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
    .map((file) => {
      const body = readFileSync(join(PAPERS_DIR, file), "utf8");
      const date = body.match(/^date:\s*(\d{4}-\d{2})/m)?.[1] ?? "—";
      const source = body.match(/\*\*Source\*\*:\s*(\[[^\]]+\]\([^)]+\))/)?.[1] ?? "—";
      return {
        slug: file.replace(/\.mdx$/, ""),
        title: body.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? file,
        date,
        source,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const table = [
    "| Paper | Published | Source |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| [${r.title}](/research/papers/${r.slug}) | ${r.date} | ${r.source} |`),
  ].join("\n");
  const content = readFileSync(indexPath, "utf8");
  const updated = content.replace(
    /(## All papers\n\n)\|[\s\S]*?\n(\n[^|])/,
    `$1${table}\n$2`,
  );
  if (updated !== content) {
    writeFileSync(indexPath, updated);
    log(null, `synced docs/research/papers/index.mdx table (${rows.length} papers)`);
  }
}

/**
 * Regenerate docs/research/authors.mdx: every author the pipeline has extracted,
 * with affiliation, ORCID/contact, and the pages they appear on. Built from the
 * stage-1 outputs rather than the rendered pages, so it stays a dataset — one
 * row per person, deduplicated by name, newest paper first.
 */
function syncAuthorsIndex() {
  const indexPath = join(DOCS_DIR, "research", "authors.mdx");
  if (!existsSync(indexPath)) return;

  const byName = new Map();
  for (const doc of listRawDocs()) {
    const analysis = readJson(join(ENRICHED_DIR, doc.id, "01-analysis.json"));
    const review = readJson(join(ENRICHED_DIR, doc.id, "04-review.json"));
    const slug = review?.research_page?.slug;
    if (!(analysis && slug)) continue;
    const paper = {
      title: analysis.title ?? slug,
      route: `/research/papers/${slugify(slug)}`,
      year: normalizeDate(analysis.published)?.iso.slice(0, 4) ?? "—",
    };
    for (const author of authorRecords(analysis)) {
      const key = author.name.trim().toLowerCase();
      const existing = byName.get(key) ?? { ...author, papers: [] };
      // Later documents fill in details an earlier one lacked, never overwrite.
      existing.affiliation ??= author.affiliation;
      existing.orcid ??= author.orcid;
      existing.email ??= author.email;
      existing.corresponding ||= Boolean(author.corresponding);
      existing.papers.push(paper);
      byName.set(key, existing);
    }
  }

  const rows = [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => {
      const contact = [
        a.orcid ? `[ORCID](${a.orcid})` : null,
        a.email ? `[email](mailto:${a.email})` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const papers = a.papers
        .sort((x, y) => y.year.localeCompare(x.year))
        .map((p) => `[${tableCell(p.title)}](${p.route}) (${p.year})`)
        .join("<br />");
      return `| ${tableCell(a.name)}${a.corresponding ? " ✉️" : ""} | ${tableCell(a.affiliation)} | ${contact || "—"} | ${papers} |`;
    });

  const table = [
    "| Author | Affiliation | Contact | Papers |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  const content = readFileSync(indexPath, "utf8");
  const updated = content.replace(/(## All authors\n\n)\|[\s\S]*?\n(\n[^|])/, `$1${table}\n$2`);
  if (updated !== content) {
    writeFileSync(indexPath, updated);
    log(null, `synced docs/research/authors.mdx (${rows.length} authors)`);
  }
}

let published = 0;
const editorNotes = [];

for (const doc of docs) {
  const review = readJson(join(ENRICHED_DIR, doc.id, "04-review.json"));
  if (!review) {
    log(doc.id, "no 04-review.json — run `pnpm enrich` first");
    continue;
  }
  const provenance = `Pipeline-generated from \`${doc.meta.source}\` (parsed ${doc.meta.parsed_at.slice(0, 10)}), then agent-reviewed. Edit freely — republishing overwrites.`;
  const receipt = { published_at: new Date().toISOString(), files: [], timeline: [] };

  // Stage outputs are read once per document: the paper page needs all of
  // them, and the trial pages need the analysis for their attribution block.
  const stages = {
    analysis: readJson(join(ENRICHED_DIR, doc.id, "01-analysis.json")),
    trials: readJson(join(ENRICHED_DIR, doc.id, "02-trials.json")),
    sentiment: readJson(join(ENRICHED_DIR, doc.id, "03-sentiment.json")),
    factCheck: review.fact_check,
  };
  const analysis = stages.analysis;

  const page = review.research_page;
  if (page?.slug) {
    ensureDir(PAPERS_DIR);
    const path = join(PAPERS_DIR, `${slugify(page.slug)}.mdx`);
    writeFileSync(path, renderResearchPage(page, provenance, doc.id, stages, doc.meta));
    receipt.files.push(`docs/research/papers/${slugify(page.slug)}.mdx`);
    log(doc.id, `wrote docs/research/papers/${slugify(page.slug)}.mdx`);
  }

  for (const trial of review.trial_pages ?? []) {
    if (!trial?.slug) continue;
    const path = join(DOCS_DIR, "trials", `${slugify(trial.slug)}.mdx`);
    writeFileSync(path, renderTrialPage(trial, provenance, doc.meta, analysis));
    receipt.files.push(`docs/trials/${slugify(trial.slug)}.mdx`);
    log(doc.id, `wrote docs/trials/${slugify(trial.slug)}.mdx`);
  }

  const timelinePath = join(DOCS_DIR, "timeline", "index.mdx");
  if (existsSync(timelinePath) && (review.timeline_entries ?? []).length > 0) {
    let timeline = readFileSync(timelinePath, "utf8");
    for (const entry of review.timeline_entries) {
      const result = insertTimelineEntry(timeline, entry);
      timeline = result.content;
      receipt.timeline.push({ title: entry.title, action: result.action });
      log(doc.id, `timeline: ${entry.title} — ${result.action}`);
    }
    writeFileSync(timelinePath, timeline);
  }

  for (const note of review.notes_for_editor ?? []) {
    editorNotes.push(`[${doc.id}] ${note}`);
  }
  writeJson(join(ENRICHED_DIR, doc.id, "published.json"), receipt);
  published++;
}

syncTrialsIndex();
syncPapersIndex();
syncAuthorsIndex();

log(null, `publish complete: ${published} document(s) rendered into docs/`);
if (editorNotes.length > 0) {
  log(null, "reviewer notes for a human:");
  for (const note of editorNotes) log(null, `  - ${note}`);
}
