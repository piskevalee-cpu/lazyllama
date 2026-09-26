import { createLazyRenderer, destroyRenderer } from "./opentui.js";
import { createAppUi } from "./controller.js";
import { themeForMode } from "./theme.js";
import type { UiDeps, UiHandles } from "./types.js";

export async function runUi(deps: UiDeps): Promise<UiHandles> {
  const { renderer, themeMode } = await createLazyRenderer({ mouse: deps.mouse });
  try {
    return createAppUi(renderer, deps, { theme: themeForMode(themeMode) });
  } catch (err) {
    destroyRenderer(renderer);
    throw err;
  }
}
