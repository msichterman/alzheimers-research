// Shared HTTP helpers for the corpus expansion: polite rate limiting per host,
// retries with backoff, and a single user-agent/contact string so every API we
// touch (NCBI, Europe PMC, Crossref, Unpaywall, ClinicalTrials.gov, FDA, EMA)
// can identify and throttle us the way its documentation asks.
import { setTimeout as sleep } from "node:timers/promises";

export const CONTACT = process.env.CORPUS_CONTACT || "matt@flamel.ai";
export const UA = `alzheimers-research-pipeline/2.0 (+https://alzheimers.dev; mailto:${CONTACT})`;
export const NCBI_KEY = process.env.NCBI_API_KEY || null;

/**
 * NCBI documents three requests per second without an API key and ten with one.
 * Everything else gets a conservative default. Gaps are per host, serialized
 * through a promise chain so concurrent callers queue rather than burst.
 */
const MIN_GAP_MS = {
  "eutils.ncbi.nlm.nih.gov": NCBI_KEY ? 110 : 350,
  "www.ncbi.nlm.nih.gov": NCBI_KEY ? 110 : 350,
  "pmc.ncbi.nlm.nih.gov": 350,
  "www.ebi.ac.uk": 120,
  "api.crossref.org": 120,
  "api.unpaywall.org": 120,
  "clinicaltrials.gov": 150,
  default: 200,
};

/**
 * Per-host concurrency. NCBI publishes a request-per-second budget, so its lane
 * is serialized behind a minimum gap. An LLM endpoint has no such budget and is
 * latency-bound rather than rate-bound — serializing it would turn a fan-out of
 * twenty independent extractions into a twenty-times-longer queue for no reason.
 */
const MAX_PARALLEL = {
  "aiplatform.googleapis.com": 6,
  "www.ebi.ac.uk": 3,
  "api.crossref.org": 3,
  "clinicaltrials.gov": 3,
  default: 1,
};

const lanes = new Map();

function laneFor(host) {
  if (!lanes.has(host)) {
    lanes.set(host, { active: 0, queue: [], lastStart: 0 });
  }
  return lanes.get(host);
}

/**
 * Acquire a slot on `host`, respecting both its parallelism cap and its minimum
 * gap between request starts. Resolves to a release function.
 */
function gate(host) {
  const lane = laneFor(host);
  const limit = MAX_PARALLEL[host] ?? MAX_PARALLEL.default;
  const gap = MIN_GAP_MS[host] ?? MIN_GAP_MS.default;

  return new Promise((resolve) => {
    const tryStart = async () => {
      if (lane.active >= limit) {
        lane.queue.push(tryStart);
        return;
      }
      lane.active++;
      const wait = Math.max(0, lane.lastStart + gap - Date.now());
      if (wait > 0) await sleep(wait);
      lane.lastStart = Date.now();
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        lane.active--;
        const nextInLine = lane.queue.shift();
        if (nextInLine) nextInLine();
      });
    };
    tryStart();
  });
}

/** Rate-limited fetch with retries. Returns the Response (never throws on 4xx). */
export async function politeFetch(url, options = {}, { retries = 3, timeoutMs = 60000 } = {}) {
  const host = new URL(url).host;
  const release = await gate(host);
  try {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          redirect: "follow",
          ...options,
          headers: { "user-agent": UA, ...(options.headers ?? {}) },
          signal: controller.signal,
        });
        clearTimeout(timer);
        // 429/5xx are worth another try; 4xx are answers.
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        return response;
      } catch (error) {
        clearTimeout(timer);
        if (attempt >= retries) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  } finally {
    release();
  }
}

export async function fetchJson(url, options) {
  const response = await politeFetch(url, options);
  if (!response.ok) return { ok: false, status: response.status, data: null };
  try {
    return { ok: true, status: response.status, data: await response.json() };
  } catch {
    return { ok: false, status: response.status, data: null };
  }
}

export async function fetchText(url, options) {
  const response = await politeFetch(url, options);
  if (!response.ok) return { ok: false, status: response.status, text: null, url: response.url };
  return { ok: true, status: response.status, text: await response.text(), url: response.url };
}

/** Add the NCBI API key when one is configured. */
export function eutils(path, params) {
  const query = new URLSearchParams({ ...params, tool: "alzheimers-research", email: CONTACT });
  if (NCBI_KEY) query.set("api_key", NCBI_KEY);
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${path}?${query}`;
}

/** Loose title comparison, for checking a resolved record against a search hint. */
export function titleKey(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSimilarity(a, b) {
  const wordsA = new Set(titleKey(a).split(" ").filter((w) => w.length > 3));
  const wordsB = new Set(titleKey(b).split(" ").filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return shared / Math.min(wordsA.size, wordsB.size);
}
