// Shared meters. The side panel and the splash draw the same gradient fill, so
// the ramp logic lives here instead of being copied per surface.

import { fg, type TextChunk } from "@opentui/core";
import { BLOCK_EMPTY, BLOCK_FULL } from "../ascii.js";
import type { UiTheme } from "./theme.js";

export interface MeterTokens {
  ramp: [string, string, string];
  track: string;
}

export function meterTokens(theme: UiTheme): MeterTokens {
  return { ramp: theme.meter, track: theme.meterTrack };
}

function clampFraction(frac: number): number {
  return Math.min(1, Math.max(0, frac));
}

// A filled meter fades through the ramp from bright to dim, so it reads as a
// gradient rather than a flat block. Three chunks regardless of the fill.
export function gradientFill(frac: number, width: number, meter: MeterTokens): TextChunk[] {
  const filled = Math.round(clampFraction(frac) * Math.max(0, width));
  if (filled <= 0) return [fg(meter.track)(BLOCK_EMPTY.repeat(Math.max(0, width)))];
  const [bright, mid, dim] = meter.ramp;
  const ramp = [bright, mid, dim];
  const chunks: TextChunk[] = [];
  for (let step = 0; step < ramp.length; step += 1) {
    const from = Math.round((step * filled) / ramp.length);
    const to = Math.round(((step + 1) * filled) / ramp.length);
    if (to > from) chunks.push(fg(ramp[step]!)(BLOCK_FULL.repeat(to - from)));
  }
  if (filled < width) chunks.push(fg(meter.track)(BLOCK_EMPTY.repeat(width - filled)));
  return chunks;
}

// Indeterminate bar for the loading splash: a gradient segment ping-pongs
// across the track, brightest at its core.
export function sweepFill(elapsedMs: number, width: number, meter: MeterTokens): TextChunk[] {
  const [bright, mid, dim] = meter.ramp;
  const segment = Math.max(3, Math.round(width / 3));
  const travel = width + segment;
  const period = Math.max(1, travel * 2 * 60);
  const step = Math.floor((elapsedMs % period) / 60);
  const head = step < travel ? step : travel * 2 - step;
  const chunks: TextChunk[] = [];
  let runColor: string | undefined;
  let run = "";
  for (let column = 0; column < width; column += 1) {
    const distance = Math.abs(column + segment / 2 - (head + segment / 2));
    const color =
      distance <= segment * 0.2
        ? bright
        : distance <= segment * 0.55
          ? mid
          : distance <= segment
            ? dim
            : meter.track;
    const glyph = color === meter.track ? BLOCK_EMPTY : BLOCK_FULL;
    if (color === runColor) {
      run += glyph;
      continue;
    }
    if (run.length > 0 && runColor !== undefined) chunks.push(fg(runColor)(run));
    runColor = color;
    run = glyph;
  }
  if (run.length > 0 && runColor !== undefined) chunks.push(fg(runColor)(run));
  return chunks;
}
