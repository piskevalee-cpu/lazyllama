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
