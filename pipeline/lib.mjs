import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCES_DIR = join(ROOT, "sources");
export const RAW_DIR = join(ROOT, "raw");
export const ENRICHED_DIR = join(ROOT, "enriched");
export const DOCS_DIR = join(ROOT, "docs");
export const PROMPTS_DIR = join(ROOT, "pipeline", "prompts");

// Vertex, not the `google` provider: OpenCode's Gemini OAuth lane needs the
// Gemini for Google Cloud API, which is off on flamel-os. Vertex runs on the
// same project through ADC and is already configured in ~/.config/opencode.
export const MODEL = process.env.PIPELINE_MODEL || "google-vertex/gemini-3.1-pro-preview";
export const MAX_TURNS = Number(process.env.PIPELINE_MAX_TURNS || 60);
export const STAGE_TIMEOUT_MS = Number(
  process.env.PIPELINE_TIMEOUT_MS || 15 * 60 * 1000,
);
export const CONCURRENCY = Number(process.env.PIPELINE_CONCURRENCY || 1);

export function log(id, message) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${id ? `[${id}] ` : ""}${message}`);
}

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** All parsed documents: raw/<id>/meta.json entries. */
export function listRawDocs(onlyIds = []) {
  if (!existsSync(RAW_DIR)) return [];
  return readdirSync(RAW_DIR)
    .filter((name) => existsSync(join(RAW_DIR, name, "meta.json")))
    .filter((name) => onlyIds.length === 0 || onlyIds.includes(name))
    .map((name) => ({
      id: name,
      dir: join(RAW_DIR, name),
      meta: readJson(join(RAW_DIR, name, "meta.json")),
      markdownPath: join(RAW_DIR, name, "document.md"),
    }));
}

/** Existing site pages (path + title) so agents can cross-link instead of duplicating. */
export function listSitePages() {
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "templates") continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".mdx")) continue;
      const body = readFileSync(full, "utf8");
      const title = body.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? entry;
      const route = full
        .slice(DOCS_DIR.length)
        .replace(/\.mdx$/, "")
        .replace(/\/index$/, "") || "/";
      pages.push({ route, title });
    }
  };
  walk(DOCS_DIR);
  return pages;
}

export function renderPrompt(templateName, values) {
  const template = readFileSync(join(PROMPTS_DIR, templateName), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing prompt value: ${key}`);
    return values[key];
  });
}

/** Extract a JSON object from an agent's final message, tolerating fences and prose. */
export function extractJson(text) {
  const attempts = [
    text.trim(),
    text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim(),
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* next attempt */
    }
  }
  throw new Error(`No valid JSON object in agent output (${text.length} chars)`);
}

/**
 * Run one agent stage via `claude -p` (headless). The prompt goes over stdin,
 * the CLI returns a JSON envelope, and we parse the agent's final message as JSON.
 * Research agents get read-only tools: web search/fetch plus Read on this repo.
 */
export async function runAgent(prompt, { id, stage, logPath }) {
  const envelope = await claudePrint(prompt, { id, stage, logPath });
  try {
    return { payload: extractJson(envelope.result), envelope };
  } catch (error) {
    log(id, `${stage}: invalid JSON, retrying once (${error.message})`);
    const retryPrompt = `${prompt}\n\nIMPORTANT: Your previous attempt did not end with valid JSON (${error.message}). Respond with ONLY the JSON object this time.`;
    const retry = await claudePrint(retryPrompt, { id, stage, logPath });
    return { payload: extractJson(retry.result), envelope: retry };
  }
}

function claudePrint(prompt, { id, stage, logPath }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "run",
      "-m", MODEL,
      "--format", "json",
    ];
    const child = spawn("opencode", args, {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${stage} timed out after ${STAGE_TIMEOUT_MS / 60000} min`));
    }, STAGE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (logPath) {
        ensureDir(dirname(logPath));
        writeFileSync(logPath, `--- args ---\n${args.join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
      }

      let resultText = "";
      let totalCost = 0;
      let turns = 0;
      let sessionID = "";

      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.sessionID) sessionID = event.sessionID;
          if (event.type === "text" && event.part?.text) {
            resultText += event.part.text;
          } else if (event.type === "step_finish") {
            turns++;
            // OpenCode carries the step cost on the part, not the event.
            const cost = event.part?.cost ?? event.cost;
            if (cost) totalCost += cost;
          }
        } catch (err) {
          // Ignore parse errors on individual lines
        }
      }

      if (code !== 0 && !resultText) {
        reject(new Error(`${stage}: opencode exited ${code}; no output. ${stderr.slice(0, 400)}`));
        return;
      }

      const envelope = {
        is_error: false,
        subtype: "success",
        result: resultText,
        duration_ms: 0,
        num_turns: turns,
        total_cost_usd: totalCost,
        session_id: sessionID
      };

      log(id, `${stage}: done, ${envelope.num_turns} turns, $${(envelope.total_cost_usd || 0).toFixed(4)}`);
      resolvePromise(envelope);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Run tasks with a concurrency cap; rejections become { error } results. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Escape a string for double-quoted YAML frontmatter. */
export function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Keep agent-authored Markdown safe inside MDX: escape bare braces, strip HTML comments. */
export function mdxSafe(markdown) {
  return String(markdown)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/([{}])/g, "\\$1")
    .trim();
}
