import type { CliRenderer, KeyEvent } from "@opentui/core";
import {
  applyFieldEdit,
  configField,
  fieldDisplay,
  loadPreset as loadStoredPreset,
  modelDisplayName,
  modelId,
  modelSourceLabel,
  nudgeField,
  savePreset as saveStoredPreset,
  type ConfigFieldDef,
  type LaunchConfig,
} from "../config.js";
import { buildModelEntries, type SelectableModelEntry } from "../hub.js";
import type { ChatMessage } from "../server.js";
import { splashFrame } from "../splash.js";
import { fetchServerStats, sampleSystem } from "../perf.js";
import { sampleGpuMemory } from "../vram.js";
import { sessionBindings, type SessionCommandContext } from "./bindings.js";
import { ChatScreen, emptySidebarData } from "./chatView.js";
import { loadFlags, saveFlags } from "./flags.js";
import { HubView, selectEditorDensity } from "./hubView.js";
import { Keymap, type KeymapContext } from "./keys.js";
import {
  keysFor,
  loadKeybinds,
  pressedCommand,
  prettySpec,
  saveKeybinds,
  type KeybindOverrides,
} from "./keybinds.js";
import { KeybindsView } from "./keybindsView.js";
import type { ScrollCommand } from "./layout.js";
import { meterTokens } from "./meter.js";
import { ManualView, type ManualScrollCommand } from "./manualView.js";
import { destroyRenderer } from "./opentui.js";
import { createShell } from "./shell.js";
import { SplashView } from "./splashView.js";
import { DARK_THEME } from "./theme.js";
import type {
  AppUiOptions,
  AssistantResult,
  AssistantStream,
  ChatView,
  HubControl,
  Screen,
  UiDeps,
  UiHandles,
} from "./types.js";

// Footer hints are generated from the registry, so they can never claim a key
// the screen does not handle, and a rebind is reflected immediately. Each entry
// names the command ids whose keys are shown and the label printed after them;
// a pair of arrows is two ids, so both keys appear.
interface ScreenHint {
  ids: string[];
  label: string;
}

const SCREEN_HINTS: Record<Screen, { full: ScreenHint[]; compact: ScreenHint[] }> = {
  splash: { full: [], compact: [] },
  models: {
    full: [
      { ids: ["hub.models.move-up", "hub.models.move-down"], label: "select" },
      { ids: ["hub.models.open"], label: "open" },
      { ids: ["hub.models.refresh"], label: "refresh" },
      { ids: ["help.manual"], label: "manual" },
    ],
    compact: [
      { ids: ["hub.models.move-up", "hub.models.move-down"], label: "select" },
      { ids: ["hub.models.open"], label: "open" },
      { ids: ["hub.models.refresh"], label: "refresh" },
    ],
  },
  edit: {
    full: [
      { ids: ["hub.edit.move-up", "hub.edit.move-down"], label: "move" },
      { ids: ["hub.edit.adjust-left", "hub.edit.adjust-right"], label: "adjust" },
      { ids: ["hub.edit.next-group"], label: "groups" },
      { ids: ["hub.edit.open"], label: "edit" },
      { ids: ["hub.edit.save"], label: "save" },
      { ids: ["help.manual"], label: "manual" },
      { ids: ["hub.edit.back"], label: "back" },
      { ids: ["app.quit"], label: "quit" },
    ],
    compact: [
      { ids: ["hub.edit.move-up", "hub.edit.move-down"], label: "move" },
      { ids: ["hub.edit.adjust-left", "hub.edit.adjust-right"], label: "adjust" },
      { ids: ["hub.edit.open"], label: "edit" },
      { ids: ["hub.edit.save"], label: "save" },
      { ids: ["hub.edit.back"], label: "back" },
    ],
  },
  manual: {
    full: [
      { ids: ["help.scroll.line-up", "help.scroll.line-down"], label: "scroll" },
      { ids: ["session.scroll.page-up", "session.scroll.page-down"], label: "page" },
      { ids: ["help.manual"], label: "manual" },
      { ids: ["help.keybinds"], label: "keybinds" },
      { ids: ["manual.close"], label: "back" },
      { ids: ["app.quit"], label: "quit" },
    ],
    compact: [
      { ids: ["help.scroll.line-up", "help.scroll.line-down"], label: "scroll" },
      { ids: ["manual.close"], label: "back" },
    ],
  },
  keybinds: {
    full: [
      { ids: ["help.scroll.line-up", "help.scroll.line-down"], label: "move" },
      { ids: ["keybinds.rebind"], label: "rebind" },
      { ids: ["keybinds.reset"], label: "default" },
      { ids: ["help.manual"], label: "manual" },
      { ids: ["keybinds.close"], label: "back" },
      { ids: ["app.quit"], label: "quit" },
    ],
    compact: [
      { ids: ["help.scroll.line-up", "help.scroll.line-down"], label: "move" },
      { ids: ["keybinds.rebind"], label: "rebind" },
      { ids: ["keybinds.close"], label: "back" },
    ],
  },
  chat: { full: [], compact: [] },
};

// Hints print one key per command, the primary one, with the ids of a pair
// joined by a slash: "←/→ adjust". A rebind replaces that key, so the reference
// follows the user's choices instead of drifting from them.
function hintKeys(overrides: KeybindOverrides, ids: string[]): string {
  return ids
    .map((id) => keysFor(overrides, id)[0] ?? "")
    .filter((key) => key.length > 0)
    .map(prettySpec)
    .join("/");
}

function screenHint(overrides: KeybindOverrides, screen: Screen, compact: boolean): string {
  return SCREEN_HINTS[screen][compact ? "compact" : "full"]
    .map((hint) => `${hintKeys(overrides, hint.ids)} ${hint.label}`.trim())
    .join(" · ");
}

const FOOTER_SIDE_PADDING = 4;
const FOOTER_GAP = 2;

// Pick the longest reference that still leaves room for the meta text, so the
// two footer slots never overlap or clip.
export function hintsFor(
  width: number,
  screen: Screen,
  meta: string,
  overrides: KeybindOverrides = {},
): string {
  const available = width - FOOTER_SIDE_PADDING - FOOTER_GAP - meta.length;
  const full = screenHint(overrides, screen, false);
  if (full.length <= available) return full;
  const compact = screenHint(overrides, screen, true);
  if (compact.length <= available) return compact;
  return "";
}

// The help screens are driven by the controller rather than by the focused
// scroller, because the controller's keypress listener runs first and would
// otherwise swallow these keys before the renderable ever saw them. The page and
// jump commands are the chat's own ids, so one rebinding scrolls both.
const HELP_SCROLL_IDS: Array<[string, ManualScrollCommand]> = [
  ["help.scroll.line-up", "line-up"],
  ["help.scroll.line-down", "line-down"],
  ["session.scroll.page-up", "page-up"],
  ["session.scroll.page-down", "page-down"],
  ["session.scroll.half-page-up", "half-page-up"],
  ["session.scroll.half-page-down", "half-page-down"],
  ["session.scroll.top", "top"],
  ["session.scroll.bottom", "bottom"],
];

const INTERRUPT_WINDOW_MS = 5000;

export function createAppUi(
  renderer: CliRenderer,
  deps: UiDeps,
  options: AppUiOptions = {},
): UiHandles {
  const splashMinMs = options.splashMinMs ?? 1700;
  const splashTickMs = options.splashTickMs ?? 90;
  const perfIntervalMs = options.perfIntervalMs ?? 1000;
  const theme = options.theme ?? DARK_THEME;
  const store = deps.presetStore ?? {
    loadPreset: loadStoredPreset,
    savePreset: saveStoredPreset,
  };
  const flags = loadFlags();
  // User keybinds, loaded once and re-resolved whenever the user rebinds one.
  let keybinds: KeybindOverrides = loadKeybinds();

  let cfg: LaunchConfig = deps.config;
  let localModels = deps.localModels;
  const transcript: ChatMessage[] = [];
  let screen: Screen = "splash";
  let contextUsed: number | undefined;
  let contextTotal: number | undefined;
  let configOpen = false;
  // The manual is an overlay on top of whatever screen opened it, so Esc
  // returns to the exact row the user left, not just to the top of a screen.
  // A help screen is an overlay on top of whatever screen opened it, so Esc
  // returns to the exact row the user left, not just to the top of a screen.
  let helpReturn: Screen = "models";
  let helpFocusId: string | null = null;
  // Tracked as a plain string: TextRenderable.content reads back as StyledText.
  let metaLine = "";
  let hubStatusText = "";
  let inFlight: AbortController | undefined;
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRequestTokPerSecond: number | undefined;
  const splashStartedAt = Date.now();
  let splashTimer: ReturnType<typeof setInterval> | undefined;
  let perfTimer: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;

  const shell = createShell(renderer, theme);
  const splash = new SplashView(renderer, theme);
  const hub = new HubView(renderer, {
    onActivateModel: (entry) => activateModel(entry),
    onActivateField: (def) => activateField(def),
    onCommitInlineEdit: (value) => commitInlineEdit(value),
    onBack: () => backToModels(),
    onSavePreset: () => {
      savePresetForCurrentModel();
      applyLayout();
    },
    onConfirm: () => confirmHub(),
  }, theme);
  const manual = new ManualView(renderer, theme);
  const keybindsView = new KeybindsView(renderer, theme, {
    onChange: (next) => {
      keybinds = next;
      saveKeybinds(next);
      // The keymap, the key handling and the hints all read the same
      // overrides, so one rebind reaches every one of them.
      rebuildKeymap();
      keybindsView.setOverrides(next);
      syncFooterHints();
    },
  });
  const chat = new ChatScreen(
    renderer,
    theme,
    {
      onSubmit: () => submitChatMessage(),
      onSidebarDismiss: () => chat.setSidebarPreference({ pref: "hide", forced: false }),
    },
    { scrollbar: flags.scrollbar, thinking: flags.thinking, sidebar: flags.sidebar, config: cfg },
  );
  shell.body.add(splash.body);
  shell.body.add(hub.body);
  shell.body.add(chat.column);
  shell.body.add(chat.sidebarBody());
  shell.body.add(manual.body);
  shell.body.add(keybindsView.body);

  const keymap = new Keymap();
  const commandContext: SessionCommandContext = {
    busy: false,
    interruptArmed: false,
    promptDirty: false,
    modalOpen: false,
    get selectionActive(): boolean {
      return selectionText(renderer).length > 0;
    },
  };
  // The chat keymap is built from the registry, so a rebind reaches it without
  // anything else knowing about the user's choices. `rebuildKeymap` is also how
  // a rebind lands: the bindings are regenerated, not patched in place.
  function rebuildKeymap(): void {
    keymap.clear();
    keymap.register(
      sessionBindings(
        commandContext,
        {
          submit: () => submitChatMessage(),
          exit: () => exitToMenu(),
          interrupt: () => handleInterrupt(),
          toggleSidebar: () => toggleSidebar(),
          toggleScrollbar: () => toggleScrollbar(),
          toggleThinking: () => toggleThinking(),
          toggleConfig: () => setConfigOpen(!configOpen),
          toggleSidebarCursor: () => chat.toggleSidebarCursor(),
          moveSidebarCursor: (delta) => {
            chat.setSidebarCursor(true);
            chat.moveSidebarCursor(delta);
          },
          activateSidebarCursor: () => chat.activateSidebarCursor(),
          clearPrompt: () => chat.clearInput(),
          scroll: (command) => scrollActive(command),
          scrollTop: () => scrollActive("top"),
          scrollBottom: () => scrollActive("bottom"),
          quit: () => deps.onQuit?.(),
          closeModal: () => setConfigOpen(false),
          clearSelection: () => renderer.clearSelection(),
        },
        keybinds,
      ),
    );
    keymap.register([
      {
        id: "selection.copy",
        keys: keysFor(keybinds, "selection.copy"),
        description: "copy",
        when: () => commandContext.selectionActive,
        run: () => copySelection(renderer),
      },
    ]);
  }

  // One scroll target: whichever scrollable the user is looking at.
  function scrollActive(command: ScrollCommand | "top" | "bottom"): void {
    if (screen === "manual") manual.scroll(command);
    else if (screen === "keybinds") keybindsView.scroll(command);
    else if (command === "top") chat.scrollTop();
    else if (command === "bottom") chat.scrollBottom();
    else chat.scroll(command);
  }

  function selectionText(target: CliRenderer): string {
    return target.getSelection()?.getSelectedText() ?? "";
  }

  function copySelection(target: CliRenderer): void {
    const text = selectionText(target);
    if (text.length === 0) return;
    target.copyToClipboardOSC52(text);
    target.clearSelection();
  }

  function syncCommandContext(): void {
    commandContext.busy = chat.isBusy();
    commandContext.interruptArmed = chat.interruptArmedNow();
    commandContext.promptDirty = !chat.promptEmpty();
    commandContext.modalOpen = configOpen;
  }

  // ---- interrupt --------------------------------------------------------

  function handleInterrupt(): void {
    if (!chat.isBusy()) return;
    if (chat.interruptArmedNow()) {
      inFlight?.abort();
      return;
    }
    chat.armInterrupt();
    if (disarmTimer !== undefined) clearTimeout(disarmTimer);
    disarmTimer = setTimeout(() => {
      disarmTimer = undefined;
      chat.disarmInterrupt();
    }, INTERRUPT_WINDOW_MS);
  }

  // ---- chat -------------------------------------------------------------

  function submitChatMessage(): void {
    if (configOpen) return;
    const text = chat.commitInput();
    if (text === null) return;
    if (chat.isBusy()) {
      chat.addNotice("still generating — Esc interrupts");
      return;
    }
    if (disarmTimer !== undefined) {
      clearTimeout(disarmTimer);
      disarmTimer = undefined;
    }
    // Snapshot completed history before the assistant placeholder exists, so
    // concurrent or repeated sends never submit an empty trailing assistant.
    const request = transcript
      .filter((message) => message.role !== "assistant" || message.content.length > 0)
      .concat({ role: "user", content: text });
    chat.addUser(text);
    transcript.push({ role: "user", content: text });
    inFlight = new AbortController();
    deps.onSend(request, chatView, inFlight.signal);
  }

  const chatView: ChatView = {
    user(text: string) {
      chat.addUser(text);
      transcript.push({ role: "user", content: text });
    },
    notice(text: string) {
      chat.addNotice(text);
    },
    startAssistant(): AssistantStream {
      const assistant = chat.beginAssistant();
      transcript.push({ role: "assistant", content: "" });
      return {
        pushThinking: (token) => assistant.pushThinking(token),
        push: (token) => assistant.push(token),
        done(detail?: AssistantResult) {
          const text = assistant.text();
          assistant.done(detail);
          const last = transcript[transcript.length - 1];
          if (last && last.role === "assistant") last.content = text;
          inFlight = undefined;
        },
      };
    },
  };

  // ---- side panel toggles -----------------------------------------------

  function toggleSidebar(): void {
    const next = chat.toggleSidebar();
    flags.sidebar = next;
    saveFlags(flags);
  }

  function toggleScrollbar(): void {
    flags.scrollbar = !flags.scrollbar;
    chat.setScrollbarVisible(flags.scrollbar);
    saveFlags(flags);
  }

  function toggleThinking(): void {
    flags.thinking = !flags.thinking;
    chat.setThinkingVisible(flags.thinking);
    saveFlags(flags);
  }

  // ---- hub --------------------------------------------------------------

  function renderMeta(): void {
    // There is no header row anymore: the model, its source and the server
    // status share the footer's right slot. `modelDisplayName` already collapses
    // an unset model to "(no model)".
    const parts = [modelDisplayName(cfg.model)];
    const source = modelSourceLabel(cfg.model);
    if (source.length > 0) parts.push(source);
    const status = deps.getServerStatus();
    if (status.length > 0) parts.push(status);
    // Drop the source before the status so the status always survives.
    metaLine = parts.join(" · ");
    shell.metaText.content = metaLine;
  }

  function syncFooterHints(): void {
    // Resolved after the meta text, so the reference is shortened to whatever
    // space is actually left.
    shell.hints.content = hintsFor(renderer.terminalWidth, screen, metaLine, keybinds);
  }

  // The prompt's left footer slot is the model's name, always visible.
  function syncPromptHint(): void {
    chat.setPromptHint(modelDisplayName(cfg.model));
  }

  function syncSidebarModel(): void {
    chat.patchSidebarData({
      model: {
        name: modelDisplayName(cfg.model),
        source: modelSourceLabel(cfg.model),
        ctxSize: cfg.ctxSize,
        gpuLayers: cfg.gpuLayers,
        temp: cfg.temp,
        topP: cfg.topP,
        topK: cfg.topK,
        thinking: cfg.thinking,
        reasoning: cfg.reasoning,
      },
    });
  }

  function applyLayout(): void {
    const chatVisible = screen === "chat";
    shell.footer.visible = !chatVisible;
    splash.setVisible(screen === "splash");
    hub.setVisible(screen === "models" || screen === "edit");
    const manualVisible = screen === "manual";
    if (manualVisible) manual.setConfig(cfg);
    manual.setVisible(manualVisible);
    if (screen === "keybinds") keybindsView.setOverrides(keybinds);
    keybindsView.setVisible(screen === "keybinds");
    if (chatVisible) {
      if (configOpen) {
        chat.showConfig(cfg);
      } else {
        chat.hideConfig();
        chat.showChat();
      }
    } else {
      chat.hide();
    }
    // Order matters: the meta text is resolved first so the reference can be
    // shortened to whatever space is actually left.
    renderMeta();
    syncPromptHint();
    syncFooterHints();
    if (screen === "edit") applyEditorDensity();
    syncSidebarModel();
    syncCommandContext();
  }

  // Fit the whole editor on screen: comfortable spacing when tall, compact
  // density when short, scrolling only when physically too short for compact.
  function applyEditorDensity(): void {
    if (screen !== "edit") return;
    const counts = hub.editorCounts();
    // Only the shell footer sits outside the editor body now: the title, action
    // row and status line are all inside it.
    const available = Math.max(0, renderer.terminalHeight - 1);
    hub.setDensity(selectEditorDensity(available, counts.fields, counts.groups));
  }

  function applyStoredPreset(): void {
    if (!cfg.model) return;
    const preset = store.loadPreset(modelId(cfg.model));
    if (preset) cfg = { ...cfg, ...preset };
  }

  function enterModels(selected = 0): void {
    localModels = deps.onRefreshModels();
    screen = "models";
    hub.setStatus(hubStatusText);
    hub.showModels(buildModelEntries(localModels), selected);
    applyLayout();
  }

  function enterEditor(selected = 0): void {
    screen = "edit";
    hub.showEditor(cfg, selected);
    applyLayout();
  }

  function enterHubFromSplash(): void {
    if (screen !== "splash") return;
    stopSplashTimer();
    if (deps.skipModelScreen && cfg.model) {
      applyStoredPreset();
      enterEditor(0);
      return;
    }
    enterModels(0);
  }

  // Leaving the chat is not a quit: the managed server keeps running and the
  // transcript keeps the conversation, so coming back is instant. A turn that is
  // still generating is left to finish and lands in the transcript.
  function exitToMenu(): void {
    if (screen !== "chat") return;
    configOpen = false;
    screen = "models";
    hubStatusText = "";
    hub.showModels(buildModelEntries(localModels), 0);
    applyLayout();
  }

  // A help screen is reachable from every screen and always returns to it,
  // including the exact row the user left. Either help key swaps between the two
  // screens without changing where they return to.
  function openHelp(target: "manual" | "keybinds"): void {
    if (screen === target) {
      // The same key again closes the screen, so it is a toggle.
      exitHelp();
      return;
    }
    if (screen === "manual" || screen === "keybinds") {
      // The other help key swaps screens without changing where they return to.
      screen = target;
      applyLayout();
      return;
    }
    helpReturn = screen;
    helpFocusId = renderer.currentFocusedRenderable?.id ?? null;
    screen = target;
    applyLayout();
  }

  function exitHelp(): void {
    const back = helpReturn === "manual" || helpReturn === "keybinds" ? "models" : helpReturn;
    screen = back;
    if (back === "edit") {
      if (helpFocusId !== null) hub.focusById(helpFocusId);
      else hub.refreshEditor(cfg);
    } else if (back === "models") {
      hub.refreshModels(buildModelEntries(localModels));
    } else if (back === "chat") {
      chat.focusPrompt();
    }
    applyLayout();
  }

  // One handler for both help screens. Every key is claimed here, so a stray
  // Enter can never reach the chat keymap behind them, and a key press that is
  // being recorded is never mistaken for a command.
  function handleHelpKey(key: KeyEvent): void {
    if (keybindsView.isRecording()) {
      keybindsView.record(key);
      return;
    }
    const closeId = screen === "keybinds" ? "keybinds.close" : "manual.close";
    if (pressedCommand(keybinds, closeId, key)) {
      exitHelp();
      return;
    }
    if (screen === "keybinds") {
      if (pressedCommand(keybinds, "help.scroll.line-up", key)) {
        keybindsView.moveCursor(-1);
        return;
      }
      if (pressedCommand(keybinds, "help.scroll.line-down", key)) {
        keybindsView.moveCursor(1);
        return;
      }
      if (pressedCommand(keybinds, "keybinds.rebind", key)) {
        keybindsView.beginRecord();
        return;
      }
      if (pressedCommand(keybinds, "keybinds.reset", key)) {
        keybindsView.resetSelected();
      }
      return;
    }
    const scroll = HELP_SCROLL_IDS.find(([id]) => pressedCommand(keybinds, id, key));
    if (scroll) manual.scroll(scroll[1]);
  }

  function backToModels(): void {
    hub.finishInlineEdit();
    enterModels(0);
  }

  function activateModel(entry: SelectableModelEntry): void {
    if (entry.kind === "hf") {
      hub.beginHfEdit();
      applyLayout();
      return;
    }
    if (entry.kind === "refresh") {
      localModels = deps.onRefreshModels();
      hub.refreshModels(buildModelEntries(localModels));
      applyLayout();
      return;
    }
    const found = localModels[entry.index];
    if (!found) {
      hubStatusText = "that model is no longer available; refresh the list";
      hub.setStatus(hubStatusText);
      applyLayout();
      return;
    }
    cfg.model = { kind: "local", path: found.path };
    applyStoredPreset();
    enterEditor(0);
  }

  function activateField(def: ConfigFieldDef): void {
    if (def.kind === "bool") {
      cfg = nudgeField(cfg, def, 1);
      hub.refreshEditor(cfg);
      applyLayout();
      return;
    }
    hub.beginFieldEdit(def, currentFieldInput(def));
    applyLayout();
  }

  function currentFieldInput(def: ConfigFieldDef): string {
    const displayed = fieldDisplay(cfg, def);
    return displayed === "(none)" ? "" : displayed;
  }

  function commitInlineEdit(value: string): void {
    const editor = hub.finishInlineEdit();
    if (!editor) return;
    if (editor.type === "hf") {
      const repo = value.trim().replace(/^hf:/, "");
      if (repo.length > 0) {
        cfg.model = { kind: "hf", repo };
        applyStoredPreset();
      }
      hub.refreshModels(buildModelEntries(localModels));
      applyLayout();
      return;
    }
    cfg = applyFieldEdit(cfg, editor.field, value);
    hub.refreshEditor(cfg);
    applyLayout();
  }

  function cancelInlineEdit(): void {
    hub.finishInlineEdit();
    if (screen === "edit") hub.refreshEditor(cfg);
    else hub.refreshModels(buildModelEntries(localModels));
    applyLayout();
  }

  function confirmHub(): void {
    if (!cfg.model) {
      hubStatusText = "pick a model first (Esc goes back to the list)";
      hub.setStatus(hubStatusText);
      applyLayout();
      return;
    }
    deps.onHubConfirm(cfg, hubControl);
  }

  function savePresetForCurrentModel(): void {
    if (!cfg.model) {
      hubStatusText = "pick a model before saving a preset";
      hub.setStatus(hubStatusText);
      return;
    }
    deps.onConfigChange({ ...cfg });
    store.savePreset(modelId(cfg.model), cfg);
    hubStatusText = `preset saved for ${modelDisplayName(cfg.model)}`;
    hub.setStatus(hubStatusText);
  }

  function nudgeSelectedField(direction: 1 | -1): void {
    if (screen !== "edit") return;
    const def = hub.selectedField();
    if (!def) return;
    cfg = nudgeField(cfg, def, direction);
    hub.refreshEditor(cfg);
  }

  function bumpContextSize(delta: number): void {
    cfg = { ...cfg, ctxSize: Math.max(0, cfg.ctxSize + delta) };
    deps.onConfigChange(cfg);
    chat.showConfig(cfg);
  }

  function setConfigOpen(open: boolean): void {
    if (screen !== "chat") return;
    configOpen = open;
    if (open) {
      chat.showConfig(cfg);
    } else {
      chat.hideConfig();
      chat.focusPrompt();
    }
    applyLayout();
  }

  const hubControl: HubControl = {
    setHubStatus(text: string) {
      hubStatusText = text;
      hub.setStatus(text);
    },
    enterChat() {
      screen = "chat";
      configOpen = false;
      const seed = emptySidebarData(cfg);
      chat.setSidebarData({
        ...seed,
        server: { ...seed.server, baseUrl: deps.getBaseUrl(), nCtx: contextTotal },
        context: { used: contextUsed, total: contextTotal },
      });
      applyLayout();
      chat.applyLayout(renderer.terminalWidth, renderer.terminalHeight);
      chat.setPromptHint(modelDisplayName(cfg.model));
    },
  };

  // ---- timers -----------------------------------------------------------

  function stopSplashTimer(): void {
    if (splashTimer !== undefined) {
      clearInterval(splashTimer);
      splashTimer = undefined;
    }
  }

  function startSplashTimer(): void {
    splash.render(splashFrame(Date.now() - splashStartedAt, theme.primary, meterTokens(theme)));
    if (splashMinMs <= 0) return;
    splashTimer = setInterval(() => {
      if (destroyed) return;
      const frame = splashFrame(Date.now() - splashStartedAt, theme.primary, meterTokens(theme));
      splash.render(frame);
      if (Date.now() - splashStartedAt >= splashMinMs) enterHubFromSplash();
    }, splashTickMs);
  }

  function startPerfTimer(): void {
    if (perfIntervalMs <= 0) return;
    perfTimer = setInterval(() => {
      if (destroyed || screen !== "chat") return;
      const system = sampleSystem();
      // VRAM comes from the vendor tools, so it is sampled on the same tick and
      // cached inside the detector rather than probed per render.
      chat.patchSidebarData({ system, gpu: sampleGpuMemory() });
      void fetchServerStats(deps.getBaseUrl()).then((server) => {
        if (destroyed) return;
        // The slot reports prompt + generated tokens, so the context meter can
        // move while the model is still working, not only after a turn.
        if (server.slotContext !== undefined) {
          chat.setLiveContext(server.slotContext.used, server.slotContext.total);
        }
        chat.patchSidebarData({
          server: {
            processing: server.activeSlots !== undefined ? server.activeSlots > 0 : false,
            tokPerSecond: server.tokPerSec ?? lastRequestTokPerSecond,
            baseUrl: deps.getBaseUrl(),
            nCtx: contextTotal,
          },
        });
      });
    }, perfIntervalMs);
  }

  // ---- input ------------------------------------------------------------

  function handleKeyPress(key: KeyEvent): void {
    if (pressedCommand(keybinds, "app.quit", key) && screen !== "chat") {
      deps.onQuit?.();
      key.stopPropagation();
      return;
    }
    if (screen === "splash") {
      enterHubFromSplash();
      key.stopPropagation();
      return;
    }
    if (hub.isEditing()) {
      if (pressedCommand(keybinds, "hub.edit.cancel", key)) {
        cancelInlineEdit();
        key.stopPropagation();
      }
      return;
    }
    // Help screens are reachable from everywhere, but only once no text input
    // is open, so `?` still types normally inside the inline editor.
    if (pressedCommand(keybinds, "help.manual", key)) {
      openHelp("manual");
      key.stopPropagation();
      return;
    }
    if (pressedCommand(keybinds, "help.keybinds", key)) {
      openHelp("keybinds");
      key.stopPropagation();
      return;
    }
    if (screen === "manual" || screen === "keybinds") {
      handleHelpKey(key);
      key.stopPropagation();
      key.preventDefault();
      return;
    }
    if (screen === "models") {
      // Up/down belong to the focused model Select; left/right mirror them so
      // every footer-advertised arrow works.
      if (pressedCommand(keybinds, "hub.models.move-left", key)) {
        hub.moveModelSelection(-1);
        key.stopPropagation();
      } else if (pressedCommand(keybinds, "hub.models.move-right", key)) {
        hub.moveModelSelection(1);
        key.stopPropagation();
      } else if (pressedCommand(keybinds, "hub.models.refresh", key)) {
        localModels = deps.onRefreshModels();
        hub.refreshModels(buildModelEntries(localModels));
        applyLayout();
        key.stopPropagation();
      }
      return;
    }
    if (screen === "edit") {
      handleEditorKey(key);
      return;
    }
    // The config modal owns its own single-letter adjustments before the
    // shared keymap sees them.
    if (configOpen && handleConfigKey(key)) {
      key.stopPropagation();
      key.preventDefault();
      return;
    }
    syncCommandContext();
    const ctx: KeymapContext = { editorFocused: renderer.currentFocusedEditor !== null };
    if (keymap.handle(key, ctx)) {
      key.stopPropagation();
      key.preventDefault();
      syncCommandContext();
    }
  }

  function handleEditorKey(key: KeyEvent): void {
    // Every key comes from the registry, so a rebind reaches the editor like
    // the chat keymap. Shift+arrow stays with the focused Select for its native
    // fast scroll.
    const fastScroll = key.shift === true && (key.name === "up" || key.name === "down");
    if (pressedCommand(keybinds, "hub.edit.next-group", key)) {
      hub.focusNextEditorControl();
      key.stopPropagation();
    } else if (pressedCommand(keybinds, "hub.edit.prev-group", key)) {
      hub.focusPreviousEditorControl();
      key.stopPropagation();
    } else if (!fastScroll && pressedCommand(keybinds, "hub.edit.move-up", key)) {
      hub.moveEditorSelection(-1);
      key.stopPropagation();
    } else if (!fastScroll && pressedCommand(keybinds, "hub.edit.move-down", key)) {
      hub.moveEditorSelection(1);
      key.stopPropagation();
    } else if (pressedCommand(keybinds, "hub.edit.adjust-left", key)) {
      // Lateral movement is context-sensitive: adjust the focused value, or
      // move between Back/Save/Confirm when an action button has focus.
      if (!hub.focusAdjacentAction(-1)) {
        nudgeSelectedField(-1);
        applyLayout();
      }
      key.stopPropagation();
      key.preventDefault();
    } else if (pressedCommand(keybinds, "hub.edit.adjust-right", key)) {
      if (!hub.focusAdjacentAction(1)) {
        nudgeSelectedField(1);
        applyLayout();
      }
      key.stopPropagation();
      key.preventDefault();
    } else if (pressedCommand(keybinds, "hub.edit.back", key)) {
      backToModels();
      key.stopPropagation();
    } else if (pressedCommand(keybinds, "hub.edit.save", key)) {
      savePresetForCurrentModel();
      applyLayout();
      key.stopPropagation();
    }
  }

  function handleConfigKey(key: KeyEvent): boolean {
    if (pressedCommand(keybinds, "overlay.adjust-left", key)) {
      bumpContextSize(-1024);
    } else if (pressedCommand(keybinds, "overlay.adjust-right", key)) {
      bumpContextSize(1024);
    } else if (pressedCommand(keybinds, "overlay.gpu", key)) {
      cycleConfigField("gpuLayers");
    } else if (pressedCommand(keybinds, "overlay.jinja", key)) {
      cycleConfigField("jinja");
    } else if (pressedCommand(keybinds, "overlay.props", key)) {
      cycleConfigField("enableProps");
    } else if (pressedCommand(keybinds, "overlay.metrics", key)) {
      cycleConfigField("enableMetrics");
    } else if (pressedCommand(keybinds, "overlay.save", key)) {
      deps.onConfigChange({ ...cfg });
      chat.showConfig(cfg);
    } else {
      return false;
    }
    syncSidebarModel();
    return true;
  }

  // The overlay's single-letter keys step the matching editor field, so they
  // walk the same states (default -> on -> off -> default) the editor does.
  function cycleConfigField(key: string): void {
    const def = configField(key);
    if (!def) return;
    cfg = nudgeField(cfg, def, 1);
    deps.onConfigChange(cfg);
    chat.showConfig(cfg);
  }

  function handleResize(width: number, height: number): void {
    chat.applyLayout(width, height);
    if (screen === "edit") applyEditorDensity();
  }

  rebuildKeymap();

  // Copy-on-release, OpenCode style: any mouse selection in the transcript is
  // copied to the system clipboard and cleared, so the next drag starts fresh.
  shell.root.onMouseUp = () => {
    copySelection(renderer);
  };

  renderer.keyInput.on("keypress", handleKeyPress);
  renderer.on("resize", handleResize);
  chat.setContext(contextUsed, contextTotal);
  applyLayout();
  chat.applyLayout(renderer.terminalWidth, renderer.terminalHeight);
  handleResize(renderer.terminalWidth, renderer.terminalHeight);
  startSplashTimer();
  startPerfTimer();
  renderer.start();

  return {
    ...chatView,
    setContext(used?: number, total?: number) {
      contextUsed = used;
      if (total !== undefined) contextTotal = total;
      chat.setContext(used, contextTotal);
    },
    setRequestStats(tokPerSecond?: number) {
      lastRequestTokPerSecond = tokPerSecond;
      chat.patchSidebarData({ server: { tokPerSecond } });
    },
    setStatus() {
      // The caller updates its own status string before calling this, so the
      // footer meta is re-read from the live getter instead of the argument.
      renderMeta();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      inFlight?.abort();
      stopSplashTimer();
      if (disarmTimer !== undefined) clearTimeout(disarmTimer);
      if (perfTimer !== undefined) {
        clearInterval(perfTimer);
        perfTimer = undefined;
      }
      chat.destroy();
      renderer.keyInput.off("keypress", handleKeyPress);
      renderer.off("resize", handleResize);
      destroyRenderer(renderer);
    },
  };
}
