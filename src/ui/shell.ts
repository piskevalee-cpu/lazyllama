// Root chrome. The chat view is OpenCode-shaped: no header bar and no status
// bar, just the transcript, the prompt dock and the optional side panel. The
// pre-chat screens get a single bottom footer instead of the old top chrome
// row: key hints on the left, the model/source/server summary on the right.

import { BoxRenderable, type CliRenderer } from "@opentui/core";
import { staticText } from "./components.js";
import { DARK_THEME, type UiTheme } from "./theme.js";

export interface ShellViews {
  root: BoxRenderable;
  /** Row hosting the transcript column plus the side panel. */
  body: BoxRenderable;
  /** Hints + model/status row. Hidden in chat, matching OpenCode's session view. */
  footer: BoxRenderable;
  hints: ReturnType<typeof staticText>;
  metaText: ReturnType<typeof staticText>;
}

export function createShell(renderer: CliRenderer, theme: UiTheme = DARK_THEME): ShellViews {
  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  const body = new BoxRenderable(renderer, {
    id: "shell-body",
    flexDirection: "row",
    flexGrow: 1,
    minHeight: 0,
  });

  const footer = new BoxRenderable(renderer, {
    id: "shell-footer",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 2,
    paddingRight: 2,
    flexShrink: 0,
  });
  const hints = staticText(renderer, { id: "hints", fg: theme.muted });
  const metaText = staticText(renderer, { id: "shell-meta", fg: theme.muted });
  footer.add(hints);
  footer.add(metaText);

  root.add(body);
  root.add(footer);
  renderer.root.add(root);
  return { root, body, footer, hints, metaText };
}
