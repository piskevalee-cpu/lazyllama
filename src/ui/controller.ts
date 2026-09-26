import type { CliRenderer, KeyEvent } from "@opentui/core";
import {
  applyFieldEdit,
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
import { sessionBindings, type SessionCommandContext } from "./bindings.js";
import { ChatScreen, emptySidebarData } from "./chatView.js";
import { loadFlags, saveFlags } from "./flags.js";
import { HubView, selectEditorDensity } from "./hubView.js";
import {
  canonicalKeyName,
  isDownKey,
  isEscapeKey,
  isLeftKey,
  isQuitKey,
  isRightKey,
  isTabBackward,
  isTabForward,
  isUpKey,
  Keymap,
  type KeymapContext,
} from "./keys.js";
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

// Footer hints are per screen and must match what the screen actually handles.
// Chat leaves the footer empty (it is hidden there and the prompt owns its own
// footer row, with the config overlay printing its own key line).
const HINTS: Record<Screen, string> = {
  splash: "press any key",
  models: "↑/↓ select · ←/→ move · Enter open · r refresh",
  edit: "↑/↓ move · ←/→ adjust · Tab groups · Enter edit · s save · Esc back · Ctrl+C quit",
  chat: "",
};

// The footer pairs the reference with the model/status meta, so narrow
// terminals get a shorter reference instead of an overlapping row.
const COMPACT_HINTS: Partial<Record<Screen, string>> = {
  models: "↑/↓ select · Enter open · r refresh",
  edit: "↑/↓ move · ←/→ adjust · Enter edit · s save · Esc back",
};

const FOOTER_SIDE_PADDING = 4;
const FOOTER_GAP = 2;

// Pick the longest reference that still leaves room for the meta text, so the
// two footer slots never overlap or clip.
export function hintsFor(width: number, screen: Screen, meta: string): string {
  const available = width - FOOTER_SIDE_PADDING - FOOTER_GAP - meta.length;
  if (HINTS[screen].length <= available) return HINTS[screen];
  const compact = COMPACT_HINTS[screen];
  if (compact !== undefined && compact.length <= available) return compact;
  return "";
}

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

  let cfg: LaunchConfig = deps.config;
  let localModels = deps.localModels;
  const transcript: ChatMessage[] = [];
  let screen: Screen = "splash";
  let contextUsed: number | undefined;
  let contextTotal: number | undefined;
  let configOpen = false;
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
  keymap.register(
    sessionBindings(commandContext, {
      submit: () => submitChatMessage(),
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
      scroll: (command) => chat.scroll(command),
      scrollTop: () => chat.scrollTop(),
      scrollBottom: () => chat.scrollBottom(),
      quit: () => deps.onQuit?.(),
      closeModal: () => setConfigOpen(false),
      clearSelection: () => renderer.clearSelection(),
    }),
  );
  keymap.register([
    {
      id: "selection.copy",
      keys: ["ctrl+c"],
      description: "copy",
      when: () => commandContext.selectionActive,
      run: () => copySelection(renderer),
    },
  ]);

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
        reasoning: cfg.reasoning,
      },
    });
  }

  function applyLayout(): void {
    const chatVisible = screen === "chat";
    shell.footer.visible = !chatVisible;
    splash.setVisible(screen === "splash");
    hub.setVisible(screen === "models" || screen === "edit");
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
    shell.hints.content = hintsFor(renderer.terminalWidth, screen, metaLine);
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
    splash.render(splashFrame(Date.now() - splashStartedAt, theme.primary));
    if (splashMinMs <= 0) return;
    splashTimer = setInterval(() => {
      if (destroyed) return;
      const frame = splashFrame(Date.now() - splashStartedAt, theme.primary);
      splash.render(frame);
      if (Date.now() - splashStartedAt >= splashMinMs) enterHubFromSplash();
    }, splashTickMs);
  }

  function startPerfTimer(): void {
    if (perfIntervalMs <= 0) return;
    perfTimer = setInterval(() => {
      if (destroyed || screen !== "chat") return;
      const system = sampleSystem();
      chat.patchSidebarData({ system });
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
    if (isQuitKey(key) && screen !== "chat") {
      deps.onQuit?.();
      key.stopPropagation();
      return;
    }
    const name = canonicalKeyName(key.name);
    if (screen === "splash") {
      enterHubFromSplash();
      key.stopPropagation();
      return;
    }
    if (hub.isEditing()) {
      if (isEscapeKey(key)) {
        cancelInlineEdit();
        key.stopPropagation();
      }
      return;
    }
    if (screen === "models") {
      // Up/down belong to the focused model Select; left/right mirror them so
      // every footer-advertised arrow works.
      if (key.name === "left") {
        hub.moveModelSelection(-1);
        key.stopPropagation();
      } else if (key.name === "right") {
        hub.moveModelSelection(1);
        key.stopPropagation();
      } else if (name === "r") {
        localModels = deps.onRefreshModels();
        hub.refreshModels(buildModelEntries(localModels));
        applyLayout();
        key.stopPropagation();
      }
      return;
    }
    if (screen === "edit") {
      handleEditorKey(key, name);
      return;
    }
    // The config modal owns its own single-letter adjustments before the
    // shared keymap sees them.
    if (configOpen && handleConfigKey(key, name)) {
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

  function handleEditorKey(key: KeyEvent, name: string): void {
    // Plain arrows walk the whole vertical editor; shift+arrows stay with
    // the focused Select for native fast scrolling. Return belongs to the
    // focused editor control or action button.
    if (isTabForward(key)) {
      hub.focusNextEditorControl();
      key.stopPropagation();
    } else if (isTabBackward(key)) {
      hub.focusPreviousEditorControl();
      key.stopPropagation();
    } else if (isUpKey(key) && !key.shift) {
      hub.moveEditorSelection(-1);
      key.stopPropagation();
    } else if (isDownKey(key) && !key.shift) {
      hub.moveEditorSelection(1);
      key.stopPropagation();
    } else if (key.name === "left") {
      // Lateral arrows are context-sensitive: adjust the focused value, or
      // move between Back/Save/Confirm when an action button has focus.
      if (!hub.focusAdjacentAction(-1)) {
        nudgeSelectedField(-1);
        applyLayout();
      }
      key.stopPropagation();
      key.preventDefault();
    } else if (key.name === "right") {
      if (!hub.focusAdjacentAction(1)) {
        nudgeSelectedField(1);
        applyLayout();
      }
      key.stopPropagation();
      key.preventDefault();
    } else if (isLeftKey(key)) {
      nudgeSelectedField(-1);
      applyLayout();
      key.stopPropagation();
      key.preventDefault();
    } else if (isRightKey(key)) {
      nudgeSelectedField(1);
      applyLayout();
      key.stopPropagation();
      key.preventDefault();
    } else if (isEscapeKey(key)) {
      backToModels();
      key.stopPropagation();
    } else if (name === "s") {
      savePresetForCurrentModel();
      applyLayout();
      key.stopPropagation();
    }
  }

  function handleConfigKey(key: KeyEvent, name: string): boolean {
    if (name === "left" || name === "-" || name === "_") {
      bumpContextSize(-1024);
    } else if (name === "right" || name === "+" || name === "=") {
      bumpContextSize(1024);
    } else if (name === "g") {
      cfg = { ...cfg, gpuLayers: cfg.gpuLayers === "auto" ? "0" : "auto" };
      deps.onConfigChange(cfg);
      chat.showConfig(cfg);
    } else if (name === "j") {
      cfg = { ...cfg, jinja: !cfg.jinja };
      deps.onConfigChange(cfg);
      chat.showConfig(cfg);
    } else if (name === "p") {
      cfg = { ...cfg, enableProps: !cfg.enableProps };
      deps.onConfigChange(cfg);
      chat.showConfig(cfg);
    } else if (name === "m") {
      cfg = { ...cfg, enableMetrics: !cfg.enableMetrics };
      deps.onConfigChange(cfg);
      chat.showConfig(cfg);
    } else if (name === "s") {
      deps.onConfigChange({ ...cfg });
      chat.showConfig(cfg);
    } else {
      return false;
    }
    syncSidebarModel();
    return true;
  }

  function handleResize(width: number, height: number): void {
    chat.applyLayout(width, height);
    if (screen === "edit") applyEditorDensity();
  }

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
