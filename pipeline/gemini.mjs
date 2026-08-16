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
//
// One access path only: Vertex AI in the `global` location, on the project the
// workspace is billed to, authenticated with Application Default Credentials.
// The consumer Generative Language API key lane and the OpenCode Gemini OAuth
// lane are both gone — two extra ways to authenticate were two extra ways for a
// run to die halfway through a corpus.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { politeFetch } from "./net.mjs";

const PROJECT =
  process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "flamel-os";
const LOCATION = process.env.GOOGLE_VERTEX_LOCATION || "global";
const BASE = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models`;
const ADC_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  join(homedir(), ".config", "gcloud", "application_default_credentials.json");

export const GEMINI_AVAILABLE = Boolean(PROJECT) && existsSync(ADC_PATH);
export const MODELS = {
  /** Deepest reasoning, 1M context — critic and long-document extraction. */
  pro: process.env.GEMINI_PRO_MODEL || "gemini-3.1-pro-preview",
  /** Cheap 1M-context pass — bulk screening and identity leads. */
  flash: process.env.GEMINI_FLASH_MODEL || "gemini-3.7-flash",
};

class GeminiError extends Error {}

/**
 * An OAuth access token for Vertex, cached until a minute before it expires.
 * The ADC file holds a refresh token, so the exchange needs no gcloud on PATH;
 * gcloud is the fallback for the service-account and impersonation cases where
 * the file is not a plain authorized_user.
 */
let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;

  let value = null;
  if (existsSync(ADC_PATH)) {
    const adc = JSON.parse(readFileSync(ADC_PATH, "utf8"));
    if (adc.type === "authorized_user") {
      const response = await politeFetch(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: adc.client_id,
            client_secret: adc.client_secret,
            refresh_token: adc.refresh_token,
            grant_type: "refresh_token",
          }).toString(),
        },
        { retries: 2, timeoutMs: 30000 },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.access_token) {
        throw new GeminiError(`ADC refresh failed: ${data?.error_description ?? `HTTP ${response.status}`}`);
      }
      cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
      return cachedToken.value;
    }
  }

  try {
    value = execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    throw new GeminiError(
      `no Vertex credentials: ${ADC_PATH} is unusable and gcloud failed (${error.message.split("\n")[0]}). Run: gcloud auth application-default login`,
    );
  }
  cachedToken = { value, expires: Date.now() + 45 * 60 * 1000 };
  return value;
}

/**
 * One generateContent call.
 * `schema` forces a JSON response shaped exactly like the record we want, so the
 * critic cannot drift into prose. `grounded` enables Google Search, which is for
 * leads only.
 */
export async function gemini(prompt, { model = MODELS.pro, schema = null, grounded = false, temperature = 0, maxOutputTokens = 32768, timeoutMs = 300000 } = {}) {
  const token = await accessToken();
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
    },
    ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
  };
  const response = await politeFetch(
    `${BASE}/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
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
