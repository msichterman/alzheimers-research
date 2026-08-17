import { defineConfig } from "blume";
import type { BlumeConfig } from "blume";
import { defineGraphRagPreset, type GraphRagPresetOptions } from "./preset-graphrag.js";

/** Strictly verifies plain JavaScript objects against prototype spoofing */
function isPlainObject(item: any): item is Record<string, any> {
  if (typeof item !== "object" || item === null) return false;
  const proto = Object.getPrototypeOf(item);
  return proto === Object.prototype || proto === null;
}

/** Deterministic circular-safe recursive serialization with sorted keys and ancestor tracking */
function sortedStringify(obj: any, ancestors = new Set()): string {
  if (!obj || typeof obj !== "object") return JSON.stringify(obj);
  if (ancestors.has(obj)) return '"[Circular]"';

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => sortedStringify(item, ancestors)).join(",")}]`;
    }
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedStringify(obj[k], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(obj);
  }
}

/** Deep clones a value including nested plain objects and arrays */
function deepClone<T>(val: T): T {
  if (Array.isArray(val)) {
    return val.map((item) => (isPlainObject(item) ? deepMerge({}, item) : deepClone(item))) as any;
  }
  if (isPlainObject(val)) {
    return deepMerge({}, val as any) as any;
  }
  return val;
}

/** Deduplicates arrays of primitives, arrays, and objects deterministically */
function dedupeArray(targetArr: any[], sourceArr: any[]): any[] {
  const combined = [...targetArr, ...sourceArr];
  const seen = new Set<string>();
  const output: any[] = [];

  for (const item of combined) {
    let key: string;
    if (isPlainObject(item)) {
      key = item.id !== undefined && item.id !== null ? String(item.id) : item.href !== undefined && item.href !== null ? String(item.href) : sortedStringify(item);
    } else if (Array.isArray(item)) {
      key = `arr:${sortedStringify(item)}`;
    } else {
      key = `prim:${typeof item}:${String(item)}`;
    }

    if (!seen.has(key)) {
      seen.add(key);
      output.push(deepClone(item));
    }
  }

  return output;
}

/**
 * Deep merges user configuration with the GraphRAG base preset safely.
 * Includes prototype pollution guards, plain-object checks, and deterministic object array deduplication.
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const output = { ...target };

  for (const key of Object.keys(source)) {
    // Prototype pollution defense
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }

    const sVal = (source as any)[key];
    const tVal = (target as any)[key];

    if (tVal === undefined) {
      output[key as keyof T] = deepClone(sVal);
    } else if (Array.isArray(sVal) && Array.isArray(tVal)) {
      output[key as keyof T] = dedupeArray(tVal, sVal) as any;
    } else if (isPlainObject(sVal) && isPlainObject(tVal)) {
      output[key as keyof T] = deepMerge(tVal, sVal) as any;
    } else if (sVal !== undefined) {
      output[key as keyof T] = deepClone(sVal);
    }
  }

  return output;
}

/**
 * Creates a fully validated Blume configuration with the GraphRAG preset applied.
 */
export function defineResearchConfig(
  userConfig: Partial<BlumeConfig> = {},
  presetOptions: GraphRagPresetOptions = {}
) {
  const preset = defineGraphRagPreset(presetOptions);
  const merged = deepMerge(preset as BlumeConfig, userConfig);
  return defineConfig(merged);
}
