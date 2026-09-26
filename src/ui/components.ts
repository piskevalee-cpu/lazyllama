import {
  BoxRenderable,
  InputRenderable,
  TextAttributes,
  TextRenderable,
  type BorderCharacters,
  type BorderSides,
  type CliRenderer,
} from "@opentui/core";

export function staticText(
  renderer: CliRenderer,
  options: {
    id?: string;
    content?: string;
    width?: number | "auto" | `${number}%`;
    textAlign?: "left" | "center" | "right";
    wrapMode?: "none" | "char" | "word";
    fg?: string;
    bold?: boolean;
  },
): TextRenderable {
  const text = new TextRenderable(renderer, {
    ...(options.id ? { id: options.id } : {}),
    content: options.content ?? "",
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.textAlign === undefined ? {} : { textAlign: options.textAlign }),
    ...(options.fg === undefined ? {} : { fg: options.fg }),
    ...(options.bold === true ? { attributes: TextAttributes.BOLD } : {}),
  });
  // wrapMode must be applied after construction: passing it to the constructor
  // makes the renderable measure against width 0 and paint nothing.
  if (options.wrapMode !== undefined) text.wrapMode = options.wrapMode;
  text.selectable = false;
  return text;
}

// Empty OpenCode-style border glyphs: only explicitly enabled sides paint.
export const OPENCODE_EMPTY_BORDER: BorderCharacters = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
};

// Frameless OpenCode-style surface: panel background, breathing room, and an
// optional single accent rule instead of a full rectangular frame.
export function surface(
  renderer: CliRenderer,
  options: {
    id: string;
    backgroundColor?: string;
    paddingLeft?: number;
    paddingRight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    flexGrow?: number;
    flexShrink?: number;
    width?: number | "auto" | `${number}%`;
    marginTop?: number;
    height?: number;
    position?: "absolute" | "relative";
    top?: number;
    left?: number;
    focusedBorderColor?: string;
    rule?: { sides: BorderSides[]; color: string; vertical?: string; bottomLeft?: string };
  },
): BoxRenderable {
  return new BoxRenderable(renderer, {
    id: options.id,
    ...(options.marginTop === undefined ? {} : { marginTop: options.marginTop }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.backgroundColor === undefined ? {} : { backgroundColor: options.backgroundColor }),
    ...(options.paddingLeft === undefined ? {} : { paddingLeft: options.paddingLeft }),
    ...(options.paddingRight === undefined ? {} : { paddingRight: options.paddingRight }),
    ...(options.paddingTop === undefined ? {} : { paddingTop: options.paddingTop }),
    ...(options.paddingBottom === undefined ? {} : { paddingBottom: options.paddingBottom }),
    ...(options.flexGrow === undefined ? {} : { flexGrow: options.flexGrow }),
    ...(options.flexShrink === undefined ? {} : { flexShrink: options.flexShrink }),
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.top === undefined ? {} : { top: options.top }),
    ...(options.left === undefined ? {} : { left: options.left }),
    ...(options.focusedBorderColor === undefined ? {} : { focusedBorderColor: options.focusedBorderColor }),
    ...(options.rule === undefined
      ? { border: false }
      : {
          border: options.rule.sides,
          borderColor: options.rule.color,
          customBorderChars: {
            ...OPENCODE_EMPTY_BORDER,
            vertical: options.rule.vertical ?? "┃",
            ...(options.rule.bottomLeft === undefined
              ? {}
              : { bottomLeft: options.rule.bottomLeft }),
          },
        }),
  });
}

export function panel(
  renderer: CliRenderer,
  options: { id: string; title: string; width?: number; flexGrow?: number },
): BoxRenderable {
  return new BoxRenderable(renderer, {
    id: options.id,
    border: true,
    borderStyle: "rounded",
    title: options.title,
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.flexGrow === undefined ? {} : { flexGrow: options.flexGrow }),
  });
}

export function lineInput(
  renderer: CliRenderer,
  options: { id: string; placeholder?: string },
): InputRenderable {
  return new InputRenderable(renderer, {
    id: options.id,
    placeholder: options.placeholder ?? "",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  });
}
