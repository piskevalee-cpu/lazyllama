import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { hintsFor, sessionBindings, type SessionCommandContext, type SessionCommands } from "../src/ui/bindings.ts";
import { Keymap, type KeymapContext } from "../src/ui/keys.ts";

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    stopPropagation() {
      (this as { propagationStopped: boolean }).propagationStopped = true;
    },
    ...mods,
  } as KeyEvent;
}

function harness(overrides: Partial<SessionCommandContext> = {}) {
  const calls: string[] = [];
  const ctx: SessionCommandContext = {
    busy: false,
    interruptArmed: false,
    promptDirty: false,
    modalOpen: false,
    selectionActive: false,
    ...overrides,
  };
  const commands: SessionCommands = {
    submit: () => calls.push("submit"),
    interrupt: () => calls.push("interrupt"),
    toggleSidebar: () => calls.push("toggleSidebar"),
    toggleScrollbar: () => calls.push("toggleScrollbar"),
    toggleThinking: () => calls.push("toggleThinking"),
    toggleConfig: () => calls.push("toggleConfig"),
    toggleSidebarCursor: () => calls.push("toggleSidebarCursor"),
    moveSidebarCursor: (d) => calls.push(`moveSidebarCursor:${d}`),
    activateSidebarCursor: () => calls.push("activateSidebarCursor"),
    clearPrompt: () => calls.push("clearPrompt"),
    scroll: (c) => calls.push(`scroll:${c}`),
    scrollTop: () => calls.push("scrollTop"),
    scrollBottom: () => calls.push("scrollBottom"),
    quit: () => calls.push("quit"),
    closeModal: () => calls.push("closeModal"),
    clearSelection: () => calls.push("clearSelection"),
  };
  const keymap = new Keymap();
  keymap.register(sessionBindings(ctx, commands));
  const editorCtx: KeymapContext = { editorFocused: false };
  return { calls, ctx, keymap, editorCtx };
}

describe("escape precedence", () => {
  test("a modal owns escape before anything else", () => {
    const h = harness({ modalOpen: true, busy: true, promptDirty: true, selectionActive: true });
    expect(h.keymap.handle(key("escape"), h.editorCtx)).toBe(true);
    expect(h.calls).toEqual(["closeModal"]);
  });

  test("a selection is cleared before the prompt is touched", () => {
    const h = harness({ selectionActive: true, promptDirty: true, busy: true });
    expect(h.keymap.handle(key("escape"), h.editorCtx)).toBe(true);
    expect(h.calls).toEqual(["clearSelection"]);
  });

  test("a busy session interrupts even with a dirty prompt", () => {
    const h = harness({ busy: true, promptDirty: true });
    expect(h.keymap.handle(key("escape"), h.editorCtx)).toBe(true);
    expect(h.calls).toEqual(["interrupt"]);
  });

  test("an idle session with text clears the prompt", () => {
    const h = harness({ promptDirty: true });
    expect(h.keymap.handle(key("escape"), h.editorCtx)).toBe(true);
    expect(h.calls).toEqual(["clearPrompt"]);
  });

  test("escape on an idle empty session is unclaimed", () => {
    const h = harness();
    expect(h.keymap.handle(key("escape"), h.editorCtx)).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe("session scroll and toggles", () => {
  test("page, half page and line keys map to the OpenCode commands", () => {
    const h = harness();
    h.keymap.handle(key("pageup"), h.editorCtx);
    h.keymap.handle(key("pagedown"), h.editorCtx);
    h.keymap.handle(key("y", { ctrl: true, option: true }), h.editorCtx);
    h.keymap.handle(key("d", { ctrl: true, option: true }), h.editorCtx);
    expect(h.calls).toEqual([
      "scroll:page-up",
      "scroll:page-down",
      "scroll:line-up",
      "scroll:half-page-down",
    ]);
  });

  test("home and end scroll only when no editor has focus", () => {
    const h = harness();
    h.keymap.handle(key("home"), { editorFocused: true });
    expect(h.calls).toEqual([]);
    h.keymap.handle(key("home"), h.editorCtx);
    h.keymap.handle(key("end"), h.editorCtx);
    expect(h.calls).toEqual(["scrollTop", "scrollBottom"]);
  });

  test("panel, scrollbar, thinking and config toggles are bound", () => {
    const h = harness();
    h.keymap.handle(key("b", { ctrl: true }), h.editorCtx);
    h.keymap.handle(key("r", { ctrl: true }), h.editorCtx);
    h.keymap.handle(key("t", { ctrl: true }), h.editorCtx);
    h.keymap.handle(key("f2"), h.editorCtx);
    expect(h.calls).toEqual(["toggleSidebar", "toggleScrollbar", "toggleThinking", "toggleConfig"]);
  });

  test("ctrl+c quits only without a selection", () => {
    const h = harness();
    h.keymap.handle(key("c", { ctrl: true }), h.editorCtx);
    expect(h.calls).toEqual(["quit"]);
    const withSelection = harness({ selectionActive: true });
    expect(withSelection.keymap.handle(key("c", { ctrl: true }), withSelection.editorCtx)).toBe(false);
    expect(withSelection.calls).toEqual([]);
  });
});

describe("prompt bindings", () => {
  test("return submits and suppresses the textarea newline action", () => {
    const h = harness();
    const k = key("return");
    expect(h.keymap.handle(k, { editorFocused: true })).toBe(true);
    expect(k.defaultPrevented).toBe(true);
    expect(h.calls).toEqual(["submit"]);
  });

  test("return is not stolen from the transcript when the editor is unfocused", () => {
    const h = harness();
    expect(h.keymap.handle(key("return"), { editorFocused: false })).toBe(false);
  });

  test("footer hints are generated from the registry", () => {
    const ctx: SessionCommandContext = {
      busy: false,
      interruptArmed: false,
      promptDirty: false,
      modalOpen: false,
      selectionActive: false,
    };
    const noop = () => {};
    const hints = hintsFor(
      sessionBindings(ctx, {
        submit: noop,
        interrupt: noop,
        toggleSidebar: noop,
        toggleScrollbar: noop,
        toggleThinking: noop,
        toggleConfig: noop,
        toggleSidebarCursor: noop,
        moveSidebarCursor: noop,
        activateSidebarCursor: noop,
        clearPrompt: noop,
        scroll: noop,
        scrollTop: noop,
        scrollBottom: noop,
        quit: noop,
        closeModal: noop,
        clearSelection: noop,
      }),
      3,
    );
    expect(hints.split(" · ").length).toBe(3);
    expect(hints).toContain("ctrl+c quit");
  });
});

describe("keymap modes", () => {
  test("modal mode disables base bindings until it is popped", () => {
    const calls: string[] = [];
    const keymap = new Keymap();
    keymap.register([
      { id: "base.one", keys: ["x"], description: "x", run: () => calls.push("base") },
      {
        id: "modal.one",
        keys: ["x"],
        description: "x",
        modes: ["modal"],
        run: () => calls.push("modal"),
      },
    ]);
    expect(keymap.handle(key("x"), { editorFocused: false })).toBe(true);
    keymap.pushMode("modal");
    expect(keymap.isModal).toBe(true);
    keymap.handle(key("x"), { editorFocused: false });
    keymap.popMode();
    keymap.handle(key("x"), { editorFocused: false });
    expect(calls).toEqual(["base", "modal", "base"]);
  });

  test("activeIds reflects the current mode and scope", () => {
    const keymap = new Keymap();
    keymap.register([
      { id: "editor.only", keys: ["a"], description: "a", scope: "editor", run: () => {} },
      { id: "global.always", keys: ["b"], description: "b", run: () => {} },
    ]);
    expect(keymap.activeIds({ editorFocused: true })).toEqual(["editor.only", "global.always"]);
    expect(keymap.activeIds({ editorFocused: false })).toEqual(["global.always"]);
  });
});
