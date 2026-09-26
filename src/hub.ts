// Main-hub model picker rows. Pure builders; the TUI layer (ui.ts)
// handles arrows/mouse, this module decides what rows exist.

import type { LocalModel } from "./models.js";

export type ModelEntry =
  | { kind: "local"; index: number; name: string; sizeMiB: number }
  | { kind: "hf" }
  | { kind: "refresh" }
  | { kind: "empty" };

export function buildModelEntries(local: LocalModel[]): ModelEntry[] {
  const rows: ModelEntry[] = local.map((m, i) => ({
    kind: "local" as const,
    index: i,
    name: m.name,
    sizeMiB: m.sizeMiB,
  }));
  if (rows.length === 0) rows.push({ kind: "empty" });
  rows.push({ kind: "hf" });
  if (local.length > 0) rows.push({ kind: "refresh" });
  return rows;
}

export type SelectableModelEntry = Exclude<ModelEntry, { kind: "empty" }>;

// Selectable rows only (the empty notice is display-only).
export function selectableEntries(rows: ModelEntry[]): SelectableModelEntry[] {
  return rows.filter((entry): entry is SelectableModelEntry => entry.kind !== "empty");
}

export function entryLabel(e: ModelEntry): string {
  switch (e.kind) {
    case "local":
      return `${e.name}  (${e.sizeMiB} MiB)`;
    case "hf":
      return "HuggingFace repo...  (type user/model[:quant])";
    case "refresh":
      return "Refresh list";
    case "empty":
      return "(no local models — drop a .gguf into models/ or pick HF below)";
  }
}
