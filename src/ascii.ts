// Pure progress helpers. Glyphs render through OpenTUI Text renderables.

export const BLOCK_FULL = "█";
export const BLOCK_EMPTY = "░";

export function hbar(frac: number, width = 20): string {
  const clamped = Math.min(1, Math.max(0, frac));
  const full = Math.round(clamped * width);
  return BLOCK_FULL.repeat(full) + BLOCK_EMPTY.repeat(width - full);
}

export function pct(frac: number): string {
  return `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}

export function thinkingDots(i: number): string {
  return ".".repeat((i % 4) + 1 - 1) + " ".repeat(3 - (i % 4));
}

/**
 * Gibibytes as a bare number, so a row can write the unit once:
 * "8.1 / 12 GiB". Values below ten keep a decimal because that is where the
 * difference still matters; above it the decimal is noise in a 36-column row.
 */
export function gibValue(bytes: number): string {
  // Zero is a real reading: an idle GPU uses no VRAM at all. Only negatives
  // and nonsense mean "unknown".
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  const gib = bytes / 1073741824;
  return gib >= 10 ? gib.toFixed(0) : gib.toFixed(1);
}

/** Gibibytes with the unit, for places that only print one number. */
export function formatGiB(bytes: number): string {
  const value = gibValue(bytes);
  return value === "--" ? value : `${value} GiB`;
}
