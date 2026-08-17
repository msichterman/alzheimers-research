// Dependency-free converters for the formats the acquisition stage produces
// alongside PDFs: JATS full-text XML from Europe PMC, ClinicalTrials.gov v2 JSON,
// and publisher/repository HTML.
//
// The goal is a faithful text layer, not a pretty page. Tables, figure captions
// and supplementary sections are kept because that is where N, effect estimates,
// multiplicity handling and ARIA counts actually live. Navigation chrome, cookie
// banners and reference lists are dropped because they crowd them out.

const decodeEntities = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const squash = (text) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ---------------------------------------------------------------- JATS XML

/** Strip tags but keep the text, so inline markup inside a paragraph survives. */
const inlineText = (xml) =>
  decodeEntities(
    String(xml)
      .replace(/<xref[^>]*>.*?<\/xref>/gs, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

function jatsTable(tableXml) {
  const rows = [...tableXml.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gs)].map((c) => inlineText(c[1]).replace(/\|/g, "\\|")),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill("")];
  const [header, ...body] = rows;
  return [
    `| ${pad(header).join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((r) => `| ${pad(r).join(" | ")} |`),
  ].join("\n");
}

/**
 * Direct children of `xml` matching one of `tags`, as {tag, inner, outer}.
 * Scanning with a depth counter rather than a regex is what keeps a nested
 * <sec> inside a <sec> from being matched twice — and keeps the recursion from
 * re-entering the element it is already inside.
 */
function childElements(xml, tags) {
  const pattern = new RegExp(`<(/?)(${tags.join("|")})\\b([^>]*)>`, "gi");
  const children = [];
  let depth = 0;
  let openTag = null;
  let openEnd = 0;
  let openStart = 0;
  for (const match of xml.matchAll(pattern)) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const selfClosing = match[3].trimEnd().endsWith("/");
    if (!closing && selfClosing) continue;
    if (!closing) {
      if (depth === 0) {
        openTag = tag;
        openStart = match.index;
        openEnd = match.index + match[0].length;
        depth = 1;
      } else if (tag === openTag) {
        // Only the open element's own nesting counts; a <p> inside a <sec> must
        // not push the <sec>'s depth, or its </p> never brings it back down.
        depth++;
      }
    } else if (tag === openTag && depth > 0) {
      depth--;
      if (depth === 0) {
        children.push({
          tag: openTag,
          inner: xml.slice(openEnd, match.index),
          outer: xml.slice(openStart, match.index + match[0].length),
        });
        openTag = null;
      }
    }
  }
  return children;
}

/** One JATS <sec>, recursively, at the given heading depth. */
function jatsSection(xml, depth = 2) {
  if (depth > 8) return `${inlineText(xml)}\n\n`;
  let out = "";
  const title = xml.match(/<title[^>]*>(.*?)<\/title>/s);
  if (title) out += `\n${"#".repeat(Math.min(depth, 6))} ${inlineText(title[1])}\n\n`;
  const body = title ? xml.slice(xml.indexOf("</title>") + 8) : xml;

  for (const child of childElements(body, ["sec", "p", "table-wrap", "fig", "list", "disp-quote"])) {
    const tag = child.tag;
    const chunk = child.inner;

    if (tag === "sec") out += jatsSection(chunk, depth + 1);
    else if (tag === "p") out += `${inlineText(chunk)}\n\n`;
    else if (tag === "list") {
      for (const item of chunk.matchAll(/<list-item[^>]*>(.*?)<\/list-item>/gs)) {
        out += `- ${inlineText(item[1])}\n`;
      }
      out += "\n";
    } else if (tag === "table-wrap") {
      const label = chunk.match(/<label[^>]*>(.*?)<\/label>/s);
      const caption = chunk.match(/<caption[^>]*>(.*?)<\/caption>/s);
      out += `\n**${label ? inlineText(label[1]) : "Table"}${caption ? `. ${inlineText(caption[1])}` : ""}**\n\n`;
      const table = chunk.match(/<table[^>]*>(.*?)<\/table>/s);
      if (table) out += `${jatsTable(table[1])}\n\n`;
    } else if (tag === "fig") {
      const label = chunk.match(/<label[^>]*>(.*?)<\/label>/s);
      const caption = chunk.match(/<caption[^>]*>(.*?)<\/caption>/s);
      if (caption) out += `*${label ? `${inlineText(label[1])}. ` : ""}${inlineText(caption[1])}*\n\n`;
    } else if (tag === "disp-quote") out += `> ${inlineText(chunk)}\n\n`;
  }
  return out;
}

/** Europe PMC / PMC JATS full text -> Markdown. */
export function jatsToMarkdown(xml) {
  const between = (tag) => {
    const open = xml.indexOf(`<${tag}>`);
    const close = xml.lastIndexOf(`</${tag}>`);
    return open === -1 || close <= open ? "" : xml.slice(open + tag.length + 2, close);
  };
  const front = between("front");
  const back = between("back");
  let body = between("body");
  // Cochrane reviews and some publisher deposits do not use a JATS <body>.
  // Falling back to the whole document keeps their text rather than emitting a
  // near-empty record that would silently fail the evidence gates.
  if (body.length < 2000 && xml.length > 20000) {
    body = xml.slice(front ? xml.indexOf("</front>") + 8 : 0, back ? xml.lastIndexOf("<back>") : undefined);
  }

  const title = front.match(/<article-title[^>]*>(.*?)<\/article-title>/s);
  const journal = front.match(/<journal-title[^>]*>(.*?)<\/journal-title>/s);
  const authors = [...front.matchAll(/<contrib\b[^>]*contrib-type="author"[^>]*>(.*?)<\/contrib>/gs)]
    .map((m) => {
      const surname = m[1].match(/<surname[^>]*>(.*?)<\/surname>/s);
      const given = m[1].match(/<given-names[^>]*>(.*?)<\/given-names>/s);
      return [given ? inlineText(given[1]) : null, surname ? inlineText(surname[1]) : null].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  const ids = [...front.matchAll(/<article-id[^>]*pub-id-type="([^"]+)"[^>]*>(.*?)<\/article-id>/gs)].map(
    (m) => `${m[1]}: ${inlineText(m[2])}`,
  );
  const licence = front.match(/<license\b[^>]*>(.*?)<\/license>/s);
  const abstract = [...front.matchAll(/<abstract\b[^>]*>(.*?)<\/abstract>/gs)]
    .map((m) => jatsSection(m[1], 3))
    .join("\n");

  const parts = [
    title ? `# ${inlineText(title[1])}` : "# (title not present in the retrieved XML)",
    "",
    authors.length ? `**Authors:** ${authors.join(", ")}` : "",
    journal ? `**Journal:** ${inlineText(journal[1])}` : "",
    ids.length ? `**Identifiers:** ${ids.join(" · ")}` : "",
    licence ? `**Licence:** ${inlineText(licence[1]).slice(0, 400)}` : "",
    "",
    abstract ? `## Abstract\n${abstract}` : "",
    jatsSection(body, 2),
  ];

  // The reference list is dropped, but funding, conflicts and data availability
  // are evidence about the record and are kept.
  for (const match of back.matchAll(/<(fn-group|ack|notes|sec)\b[^>]*>(.*?)<\/\1>/gs)) {
    const text = inlineText(match[2]);
    if (/fund|support|grant|conflict|competing|disclosure|data availab|ethic/i.test(text)) {
      parts.push(`\n## Back matter\n\n${text}\n`);
    }
  }
  return squash(parts.filter(Boolean).join("\n"));
}

// -------------------------------------------------- ClinicalTrials.gov JSON

const bullet = (label, value) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)
    ? ""
    : `- **${label}:** ${Array.isArray(value) ? value.join(", ") : value}\n`;

/**
 * A registry record rendered so an extraction agent reads it the same way it
 * reads a paper. Mutable fields are printed under an explicit observation
 * heading with the timestamp, so they can never be copied as timeless facts.
 */
export function ctgovToMarkdown(json, { observedAt } = {}) {
  const p = json.protocolSection ?? {};
  const id = p.identificationModule ?? {};
  const status = p.statusModule ?? {};
  const design = p.designModule ?? {};
  const arms = p.armsInterventionsModule ?? {};
  const outcomes = p.outcomesModule ?? {};
  const eligibility = p.eligibilityModule ?? {};
  const sponsor = p.sponsorCollaboratorsModule ?? {};
  const stamp = observedAt ?? new Date().toISOString();

  const out = [
    `# ${id.briefTitle ?? id.nctId ?? "Registry record"}`,
    "",
    id.officialTitle ? `**Official title:** ${id.officialTitle}\n` : "",
    "## Registry identity\n",
    bullet("NCT ID", id.nctId),
    bullet("Other IDs", [id.orgStudyIdInfo?.id, ...(id.secondaryIdInfos ?? []).map((s) => s.id)].filter(Boolean)),
    bullet("Lead sponsor", sponsor.leadSponsor?.name),
    bullet("Collaborators", (sponsor.collaborators ?? []).map((c) => c.name)),
    bullet("Study type", design.studyType),
    bullet("Allocation", design.designInfo?.allocation),
    bullet("Masking", design.designInfo?.maskingInfo?.masking),
    bullet("Primary purpose", design.designInfo?.primaryPurpose),
    bullet("Results posted", String(Boolean(json.hasResults))),
    "",
    `## Mutable fields — observed ${stamp} from the ClinicalTrials.gov API v2\n`,
    "*These values describe the registry record at the moment of retrieval. They are not timeless facts and must carry this observation stamp wherever they are reused.*\n",
    bullet("Overall status", status.overallStatus),
    bullet("Why stopped", status.whyStopped),
    bullet("Phase", design.phases),
    bullet("Enrollment", design.enrollmentInfo ? `${design.enrollmentInfo.count} (${design.enrollmentInfo.type})` : null),
    bullet("Start date", status.startDateStruct?.date),
    bullet("Primary completion", status.primaryCompletionDateStruct?.date),
    bullet("Completion", status.completionDateStruct?.date),
    bullet("First posted", status.studyFirstPostDateStruct?.date),
    bullet("Last update posted", status.lastUpdatePostDateStruct?.date),
    "",
    "## Prespecified outcome measures\n",
    "*Order and wording as registered. This is the prespecification baseline a publication is checked against.*\n",
  ];

  const outcomeBlock = (label, list) => {
    if (!list?.length) return;
    out.push(`### ${label}\n`);
    list.forEach((o, i) => {
      out.push(`${i + 1}. **${o.measure ?? "(unnamed)"}**`);
      if (o.timeFrame) out.push(`   - Time frame: ${o.timeFrame}`);
      if (o.description) out.push(`   - Description: ${o.description}`);
    });
    out.push("");
  };
  outcomeBlock("Primary outcome measures", outcomes.primaryOutcomes);
  outcomeBlock("Secondary outcome measures", outcomes.secondaryOutcomes);
  outcomeBlock("Other pre-specified outcome measures", outcomes.otherOutcomes);

  if (arms.armGroups?.length) {
    out.push("## Arms\n");
    for (const arm of arms.armGroups) {
      out.push(`- **${arm.label}** (${arm.type ?? "type not stated"}): ${arm.description ?? "no description"}`);
    }
    out.push("");
  }
  if (arms.interventions?.length) {
    out.push("## Interventions\n");
    for (const intervention of arms.interventions) {
      out.push(`- **${intervention.type}: ${intervention.name}** — ${intervention.description ?? "no description"}`);
    }
    out.push("");
  }

  out.push("## Eligibility\n");
  out.push(bullet("Sex", eligibility.sex));
  out.push(bullet("Minimum age", eligibility.minimumAge));
  out.push(bullet("Maximum age", eligibility.maximumAge));
  out.push(bullet("Healthy volunteers", String(eligibility.healthyVolunteers ?? "")));
  if (eligibility.eligibilityCriteria) out.push(`\n\`\`\`\n${eligibility.eligibilityCriteria}\n\`\`\`\n`);

  if (p.descriptionModule?.briefSummary) out.push(`## Brief summary\n\n${p.descriptionModule.briefSummary}\n`);
  if (p.descriptionModule?.detailedDescription) out.push(`## Detailed description\n\n${p.descriptionModule.detailedDescription}\n`);

  // Posted results, when they exist, are primary evidence and outrank any paper's summary of them.
  const results = json.resultsSection;
  if (results) {
    out.push("## Posted results\n");
    const participants = results.participantFlowModule;
    if (participants?.groups?.length) {
      out.push("### Participant flow groups\n");
      for (const g of participants.groups) out.push(`- **${g.title}**: ${g.description ?? ""}`);
      out.push("");
    }
    for (const outcome of results.outcomeMeasuresModule?.outcomeMeasures ?? []) {
      out.push(`### ${outcome.type}: ${outcome.title}`);
      if (outcome.description) out.push(outcome.description);
      if (outcome.timeFrame) out.push(`Time frame: ${outcome.timeFrame}`);
      if (outcome.populationDescription) out.push(`Population: ${outcome.populationDescription}`);
      for (const cls of outcome.classes ?? []) {
        for (const category of cls.categories ?? []) {
          for (const measurement of category.measurements ?? []) {
            out.push(
              `- ${[cls.title, category.title].filter(Boolean).join(" / ") || "value"}: ${measurement.value}${measurement.spread ? ` (spread ${measurement.spread})` : ""}${measurement.lowerLimit ? ` [${measurement.lowerLimit}, ${measurement.upperLimit}]` : ""}`,
            );
          }
        }
      }
      for (const analysis of outcome.analyses ?? []) {
        out.push(
          `- Analysis: ${[analysis.paramType, analysis.paramValue].filter(Boolean).join(" ")}${analysis.ciLowerLimit ? ` (95% CI ${analysis.ciLowerLimit} to ${analysis.ciUpperLimit})` : ""}${analysis.pValue ? `, p=${analysis.pValue}` : ""}${analysis.nonInferiorityType ? `, ${analysis.nonInferiorityType}` : ""}${analysis.statisticalMethod ? `, ${analysis.statisticalMethod}` : ""}`,
        );
        if (analysis.otherAnalysisDescription) out.push(`  - ${analysis.otherAnalysisDescription}`);
      }
      out.push("");
    }
    const events = results.adverseEventsModule;
    if (events) {
      out.push("### Adverse events\n");
      out.push(bullet("Frequency threshold", events.frequencyThreshold));
      for (const group of events.eventGroups ?? []) {
        out.push(
          `- **${group.title}**: serious ${group.seriousNumAffected ?? "?"}/${group.seriousNumAtRisk ?? "?"}, other ${group.otherNumAffected ?? "?"}/${group.otherNumAtRisk ?? "?"}, deaths ${group.deathsNumAffected ?? "?"}/${group.deathsNumAtRisk ?? "?"}`,
        );
      }
      const listEvents = (label, list) => {
        if (!list?.length) return;
        out.push(`\n**${label}**\n`);
        for (const e of list.slice(0, 60)) {
          const counts = (e.stats ?? [])
            .map((s) => `${s.groupId}: ${s.numAffected ?? s.numEvents ?? "?"}/${s.numAtRisk ?? "?"}`)
            .join("; ");
          out.push(`- ${e.term}${e.organSystem ? ` (${e.organSystem})` : ""} — ${counts}`);
        }
      };
      listEvents("Serious adverse events", events.seriousEvents);
      listEvents("Other adverse events", events.otherEvents);
      out.push("");
    }
  }
  return squash(out.filter((line) => line !== "").join("\n"));
}

// ---------------------------------------------------------------- HTML

const DROP_TAGS = /<(script|style|noscript|svg|nav|footer|header|form|iframe|button|aside)\b[^>]*>.*?<\/\1>/gis;

/** Publisher / repository HTML -> Markdown, keeping tables and captions. */
export function htmlToMarkdown(html) {
  let text = html.replace(/<!--.*?-->/gs, "").replace(DROP_TAGS, " ");

  // Prefer the article body when the page marks one, to skip site chrome.
  const article =
    text.match(/<article\b[^>]*>(.*?)<\/article>/is)?.[1] ??
    text.match(/<main\b[^>]*>(.*?)<\/main>/is)?.[1] ??
    text.match(/<div\b[^>]*(?:id|class)="[^"]*(?:article-body|content-body|fulltext|article-text|body-content)[^"]*"[^>]*>(.*?)<\/div>/is)?.[1] ??
    text;

  const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1];
  let out = title ? `# ${inlineText(title)}\n\n` : "";

  // Tables carry the numbers; convert them before the tags are flattened.
  const tables = [];
  let body = article.replace(/<table\b[^>]*>(.*?)<\/table>/gis, (match, inner) => {
    tables.push(jatsTable(inner));
    return `\n@@TABLE${tables.length - 1}@@\n`;
  });

  body = body
    .replace(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/gis, (_, level, inner) => `\n\n${"#".repeat(Number(level))} ${inlineText(inner)}\n\n`)
    .replace(/<li\b[^>]*>(.*?)<\/li>/gis, (_, inner) => `- ${inlineText(inner)}\n`)
    .replace(/<(p|div|section|tr|br)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  out += decodeEntities(body);
  out = out.replace(/@@TABLE(\d+)@@/g, (_, i) => `\n${tables[Number(i)]}\n`);
  return squash(out);
}
