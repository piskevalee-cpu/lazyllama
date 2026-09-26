// Boot splash animation: the LazyLlama block wordmark reveals line-by-line,
// then an Omarchy-style green glint sweeps back and forth across it.
// Pure frame function so tests can assert the sequence.

import { StyledText, bold, fg } from "@opentui/core";
import { LAZYLLAMA_LOGO } from "./logo.js";
import { activityFrame } from "./ui/spinner.js";

export const SPLASH_REVEAL_MS_PER_LINE = 120;
export const SPLASH_GLINT_STEP_MS = 60;
const SPLASH_GLINT_MARGIN = 8;
const SPLASH_GLINT_LEAN = 2;
const SPLASH_GLINT_WIDTH = 3;
const SPLASH_GLINT_FG = "#22c55e";

export interface SplashFrame {
  logo: string; // visible logo lines so far
  styledLogo: StyledText; // centered wordmark with the animated glint
  status: string; // animated status line: spinner + loading label
  done: boolean; // reveal complete (the glint keeps sweeping)
}

export function logoLines(): string[] {
  return LAZYLLAMA_LOGO.split("\n");
}

// Ping-pong sweep across the full logo width so the highlight always stays
// on the wordmark instead of wrapping past it.
export function splashGlintSweep(elapsedMs: number, width: number): number {
  const travel = Math.max(0, width) + SPLASH_GLINT_MARGIN * 2;
  const period = Math.max(1, travel) * 2 * SPLASH_GLINT_STEP_MS;
  const step = Math.floor((elapsedMs % period) / SPLASH_GLINT_STEP_MS);
  const position = step < travel ? step : travel * 2 - step;
  return position - SPLASH_GLINT_MARGIN;
}

function styledLogo(
  lines: string[],
  elapsedMs: number,
  done: boolean,
  glintFg = SPLASH_GLINT_FG,
): StyledText {
  const width = lines.reduce((max, line) => Math.max(max, Array.from(line).length), 0);
  const sweep = splashGlintSweep(elapsedMs, width);
  const chunks = [];
  for (const [row, line] of lines.entries()) {
    for (const [column, char] of Array.from(line).entries()) {
      const highlightStart = sweep - row * SPLASH_GLINT_LEAN;
      const distance = column - highlightStart;
      if (done && distance >= 0 && distance < SPLASH_GLINT_WIDTH) {
        chunks.push(distance === 1 ? fg(glintFg)(char) : bold(fg(glintFg)(char)));
      } else {
        chunks.push({ __isChunk: true as const, text: char });
      }
    }
    if (row < lines.length - 1) chunks.push({ __isChunk: true as const, text: "\n" });
  }
  return new StyledText(chunks);
}

export function splashFrame(elapsedMs: number, glintFg = SPLASH_GLINT_FG): SplashFrame {
  const lines = logoLines();
  const shown = Math.min(lines.length, Math.floor(elapsedMs / SPLASH_REVEAL_MS_PER_LINE) + 1);
  const visibleLines = lines.slice(0, shown);
  const done = shown >= lines.length;
  const tick = Math.floor(elapsedMs / 120);
  return {
    logo: visibleLines.join("\n"),
    styledLogo: styledLogo(visibleLines, elapsedMs, done, glintFg),
    status: `${activityFrame(tick)} loading lazyllama`,
    done,
  };
}
