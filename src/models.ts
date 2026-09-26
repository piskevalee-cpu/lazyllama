// Local model discovery. models/ is the zero-setup home for GGUF files:
// drop one in, run lazyllama, it just works.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function defaultModelsDir(): string {
  const fromEnv = process.env["LAZYLLAMA_MODELS_DIR"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(process.cwd(), "models");
}

export interface LocalModel {
  name: string; // file name
  path: string; // absolute path
  sizeMiB: number;
  mtimeMs: number;
}

const MODEL_EXTS = new Set([".gguf", ".bin"]);

export function scanLocalModels(dir?: string): LocalModel[] {
  const root = dir ?? defaultModelsDir();
  if (!existsSync(root)) return [];
  const out: LocalModel[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of entries) {
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot < 0 || !MODEL_EXTS.has(lower.slice(dot))) continue;
    const path = join(root, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ name, path, sizeMiB: Math.round(st.size / 1048576), mtimeMs: st.mtimeMs });
    } catch {
      // unreadable entry; skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
