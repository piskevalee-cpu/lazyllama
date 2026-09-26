// Activity indicator frames replicate OpenCode's Braille spinner sequence.
// The imperative UI renders these as text; OpenCode renders the same sequence
// through its Solid spinner component with an animations-enabled fallback.
export const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function activityFrame(index: number): string {
  const frame = ACTIVITY_FRAMES[((index % ACTIVITY_FRAMES.length) + ACTIVITY_FRAMES.length) % ACTIVITY_FRAMES.length];
  return frame ?? ACTIVITY_FRAMES[0] ?? "⠋";
}
