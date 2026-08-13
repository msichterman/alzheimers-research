// Google Gemini lane.
//
// Two jobs, both chosen because a second model family is genuinely better here
// than more of the same one:
//
//  1. Cross-model critic. The fidelity bar asks for an independent re-extraction
//     that is then diffed against the record. A critic from a different model
//     family shares no tokenizer, no training mix and no failure modes with the
//     builder, so its disagreements are informative rather than correlated.
//
//  2. Long-context extraction. A 246-page EMA assessment report or an FDA
//     statistical review does not fit a normal working context. Gemini's 1M-token
//     window takes the whole document in one pass, so the extraction sees the
//     safety tables and the multiplicity discussion together.
//
// Grounded search is used only to generate LEADS. Anything it returns —
// a DOI, a PMID, an NCT id — goes back through pipeline/resolve.mjs and is
// verified against Crossref, Europe PMC, NCBI or ClinicalTrials.gov before it is
// allowed near a record. A model's recall is never evidence here.
import { politeFetch } from "./net.mjs";

const KEY = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || null;
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const GEMINI_AVAILABLE = Boolean(KEY);
export const MODELS = {
  /** Deepest reasoning, 1M context — critic and long-document extraction. */
  pro: process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro-preview",
  /** Cheap 1M-context pass — bulk screening and identity leads. */
  flash: process.env.GEMINI_FLASH_MODEL || "gemini-3.6-flash",
};

class GeminiError extends Error {}

/**
 * One generateContent call.
 * `schema` forces a JSON response shaped exactly like the record we want, so the
 * critic cannot drift into prose. `grounded` enables Google Search, which is for
 * leads only.
 */
export async function gemini(prompt, { model = MODELS.pro, schema = null, grounded = false, temperature = 0, maxOutputTokens = 32768, timeoutMs = 300000 } = {}) {
  if (!KEY) throw new GeminiError("GOOGLE_AI_API_KEY is not set");
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
    },
    ...(grounded ? { tools: [{ google_search: {} }] } : {}),
  };
  const response = await politeFetch(
    `${BASE}/${model}:generateContent?key=${KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { retries: 2, timeoutMs },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    throw new GeminiError(`${model}: ${data?.error?.message ?? `HTTP ${response.status}`}`);
  }
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new GeminiError(`${model}: no candidate returned`);
  if (candidate.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
    throw new GeminiError(`${model}: finished as ${candidate.finishReason}`);
  }
  const text = (candidate.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  const citations = (candidate.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter(Boolean);
  const usage = data.usageMetadata ?? {};
  return {
    text,
    json: schema ? safeJson(text) : null,
    citations,
    model,
    truncated: candidate.finishReason === "MAX_TOKENS",
    tokens: { in: usage.promptTokenCount ?? null, out: usage.candidatesTokenCount ?? null },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new GeminiError("structured response was not valid JSON");
    return JSON.parse(text.slice(start, end + 1));
  }
}

/** JSON-schema helpers: the API wants uppercase type names and explicit nullability. */
export const S = {
  str: (description) => ({ type: "STRING", nullable: true, description }),
  int: (description) => ({ type: "INTEGER", nullable: true, description }),
  num: (description) => ({ type: "NUMBER", nullable: true, description }),
  bool: (description) => ({ type: "BOOLEAN", nullable: true, description }),
  arr: (items, description) => ({ type: "ARRAY", items, description }),
  obj: (properties, required = []) => ({ type: "OBJECT", properties, required }),
};
