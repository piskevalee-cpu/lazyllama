// Chat surface: transcript + prompt dock on the left, OpenCode-style side
// panel on the right, and a modal config overlay. The controller owns state
// and keybindings; this class owns renderables and their layout.

import { BoxRenderable, type CliRenderer, type TextRenderable } from "@opentui/core";
import {
  CONFIG_FIELDS,
  CONFIG_GROUP_ORDER,
  CONFIG_GROUP_TITLES,
  fieldDisplay,
  modelDisplayName,
  type ConfigFieldGroup,
  type ConfigFieldDef,
  type LaunchConfig,
} from "../config.js";
import { staticText, surface } from "./components.js";
import {
  promptMaxHeight,
  scrollDelta,
  sidebarMode,
  toggleSidebar as nextSidebarState,
  type ScrollCommand,
  type SidebarMode,
  type SidebarState,
} from "./layout.js";
import { PromptBox } from "./prompt.js";
import { SidePanel, type SidebarData } from "./sidebar.js";
import { Transcript, type ActiveAssistantMessage } from "./transcript.js";
import { DARK_THEME, type UiTheme } from "./theme.js";
import type { AssistantStream } from "./types.js";

export interface ChatScreenEvents {
  /** Plain Enter in the prompt. The controller reads the text. */
  onSubmit(): void;
  /** Click on the overlay scrim while the side panel is forced open. */
  onSidebarDismiss(): void;
}

export interface ChatScreenOptions {
  scrollbar: boolean;
  thinking: boolean;
  sidebar: SidebarState;
  config?: LaunchConfig;
}

const CONFIG_MODAL_WIDTH = 72;

export class ChatScreen {
  /** Left column: transcript above, prompt dock below. */
  readonly column: BoxRenderable;
  readonly sidebar: SidePanel;
  private readonly transcript: Transcript;
  private readonly prompt: PromptBox;
  private readonly configScrim: BoxRenderable;
  private readonly configBody: BoxRenderable;
  private readonly configText: TextRenderable;
  private sidebarState: SidebarState;
  private scrollbarVisible: boolean;
  private thinkingVisible: boolean;
  private contextUsed: number | undefined;
  private contextTotal: number | undefined;
  private busy = false;
  private interruptArmed = false;
  private configOpen = false;
  private visible = false;
  // The side panel belongs to the chat surface only: the splash, model picker
  // and config editor own the whole terminal width.
  private panelActive = false;
  private terminalWidth = 80;
  private terminalHeight = 24;
  private sidebarData: SidebarData;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly theme: UiTheme = DARK_THEME,
    private readonly events: ChatScreenEvents,
    options: ChatScreenOptions,
  ) {
    this.sidebarState = options.sidebar;
    this.scrollbarVisible = options.scrollbar;
    this.thinkingVisible = options.thinking;
    this.sidebarData = emptySidebarData(options.config);

    this.column = new BoxRenderable(renderer, {
      id: "chat-col",
      flexDirection: "column",
      flexGrow: 1,
      // Yoga defaults flexShrink to 0, which would let the transcript keep its
      // content width and run underneath the side panel.
      flexShrink: 1,
      minWidth: 0,
      minHeight: 0,
      // Distance between the last message and the prompt dock, the way
      // OpenCode's session column keeps a gap above the prompt.
      gap: 1,
      paddingLeft: 2,
      paddingRight: 2,
      paddingBottom: 1,
      visible: false,
    });

    this.transcript = new Transcript({
      renderer,
      theme,
      scrollbarVisible: this.scrollbarVisible,
      showThinking: this.thinkingVisible,
    });
    this.column.add(this.transcript.body);

    this.prompt = new PromptBox(renderer, theme, { onSubmit: () => this.events.onSubmit() });
    this.prompt.setPlaceholder("Ask anything…");
    this.column.add(this.prompt.body);

    this.sidebar = new SidePanel(renderer, theme, () => this.events.onSidebarDismiss());

    this.configScrim = new BoxRenderable(renderer, {
      id: "config-scrim",
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "#000000b0",
      zIndex: 50,
      visible: false,
    });
    this.configBody = surface(renderer, {
      id: "config-body",
      position: "absolute",
      top: 2,
      left: 4,
      width: CONFIG_MODAL_WIDTH,
      backgroundColor: theme.panel,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      rule: { sides: ["left"], color: theme.accent },
    });
    this.configBody.add(
      staticText(renderer, { id: "config-title", content: "Config  ·  Esc closes", fg: theme.text, bold: true }),
    );
    this.configText = staticText(renderer, { id: "config-text", fg: theme.text });
    this.configText.wrapMode = "word";
    this.configBody.add(this.configText);
    this.configBody.add(
      staticText(renderer, {
        id: "config-keys",
        content: "left/right ctx · g gpu · j jinja · p props · m metrics · s save",
        fg: theme.muted,
      }),
    );
    this.configScrim.add(this.configBody);
    renderer.root.add(this.configScrim);
    if (options.config) this.showConfig(options.config);
  }

  sidebarBody(): BoxRenderable {
    return this.sidebar.body;
  }

  showChat(): void {
    this.visible = true;
    this.panelActive = true;
    this.column.visible = true;
    this.configScrim.visible = false;
    this.configOpen = false;
    this.syncPrompt();
    this.applySidebarMode();
    this.prompt.focus();
  }

  hide(): void {
    this.visible = false;
    this.panelActive = false;
    this.column.visible = false;
    this.hideConfig();
    this.setSidebarCursor(false);
    this.applySidebarMode();
    this.prompt.blur();
  }

  isVisible(): boolean {
    return this.visible;
  }

  applyLayout(width: number, height: number): void {
    this.terminalWidth = width;
    this.terminalHeight = height;
    this.prompt.setMaxHeight(promptMaxHeight(height));
    this.applySidebarMode();
    this.configBody.width = Math.max(20, Math.min(CONFIG_MODAL_WIDTH, width - 4));
    this.configBody.left = Math.max(0, Math.floor((width - this.configBody.width) / 2));
    this.configBody.top = Math.max(0, Math.floor(height / 2) - 4);
  }

  private sidebarMode(): SidebarMode {
    if (!this.panelActive) return "hidden";
    return sidebarMode(this.terminalWidth, this.sidebarState);
  }

  private applySidebarMode(): void {
    this.sidebar.setMode(this.sidebarMode());
  }

  // ---- side panel -------------------------------------------------------

  sidebarPreference(): SidebarState {
    return this.sidebarState;
  }

  setSidebarPreference(state: SidebarState): void {
    this.sidebarState = state;
    this.applySidebarMode();
  }

  toggleSidebar(): SidebarState {
    this.setSidebarPreference(nextSidebarState(this.sidebarState, this.terminalWidth));
    return this.sidebarState;
  }

  setSidebarData(data: SidebarData): void {
    this.sidebarData = data;
    this.sidebar.setData(data);
  }

  patchSidebarData(patch: {
    context?: SidebarData["context"];
    server?: Partial<SidebarData["server"]>;
    system?: SidebarData["system"];
    model?: SidebarData["model"];
    gpu?: SidebarData["gpu"];
  }): void {
    this.sidebarData = {
      model: patch.model ?? this.sidebarData.model,
      server: { ...this.sidebarData.server, ...(patch.server ?? {}) },
      context: patch.context ?? this.sidebarData.context,
      gpu: patch.gpu ?? this.sidebarData.gpu,
      system: patch.system ?? this.sidebarData.system,
    };
    this.sidebar.setData(this.sidebarData);
  }

  setSidebarCursor(visible: boolean): void {
    this.sidebar.setCursorVisible(visible);
  }

  toggleSidebarCursor(): void {
    this.sidebar.setCursorVisible(!this.sidebar.isCursorVisible());
    if (this.sidebar.isCursorVisible()) this.prompt.blur();
    else this.prompt.focus();
  }

  moveSidebarCursor(delta: 1 | -1): void {
    this.sidebar.moveCursor(delta);
  }

  activateSidebarCursor(): void {
    this.sidebar.activateCursor();
  }

  setScrollbarVisible(visible: boolean): void {
    this.scrollbarVisible = visible;
    this.transcript.setScrollbarVisible(visible);
  }

  scrollbarVisibleNow(): boolean {
    return this.scrollbarVisible;
  }

  setThinkingVisible(visible: boolean): void {
    this.thinkingVisible = visible;
    this.transcript.setShowThinking(visible);
  }

  thinkingVisibleNow(): boolean {
    return this.thinkingVisible;
  }

  // ---- prompt -----------------------------------------------------------

  focusPrompt(): void {
    this.sidebar.setCursorVisible(false);
    this.prompt.focus();
  }

  blurPrompt(): void {
    this.prompt.blur();
  }

  promptFocused(): boolean {
    return this.prompt.isFocused();
  }

  promptEmpty(): boolean {
    return this.prompt.isEmpty();
  }

  commitInput(): string | null {
    return this.prompt.commit();
  }

  clearInput(): void {
    this.prompt.clear();
  }

  setPromptHint(text: string): void {
    this.prompt.setHint(text);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.interruptArmed = false;
    this.syncPrompt();
  }

  isBusy(): boolean {
    return this.busy;
  }

  // Two-step interrupt: the first Esc arms, the second one inside the window
  // aborts. Mirrors OpenCode's `session.interrupt`.
  armInterrupt(): boolean {
    if (!this.busy) return false;
    this.interruptArmed = true;
    this.syncPrompt();
    return true;
  }

  disarmInterrupt(): void {
    this.interruptArmed = false;
    this.syncPrompt();
  }

  interruptArmedNow(): boolean {
    return this.interruptArmed;
  }

  private syncPrompt(): void {
    this.prompt.setStatus({
      busy: this.busy,
      interruptArmed: this.interruptArmed,
      contextUsed: this.contextUsed,
      contextTotal: this.contextTotal,
    });
    this.prompt.setPlaceholder(this.transcript.isEmpty() ? "Ask anything…" : undefined);
  }

  // Live slot footprint from /slots, refreshed while a request is running.
  // Turn timings still overwrite it with the exact numbers when they arrive.
  setLiveContext(used: number, total?: number): void {
    this.contextUsed = used;
    if (total !== undefined && total > 0) this.contextTotal = total;
    this.syncPrompt();
    this.patchSidebarData({
      context: { used, total: this.contextTotal },
      server: { nCtx: this.contextTotal },
    });
  }

  setContext(used?: number, total?: number): void {
    this.contextUsed = used;
    this.contextTotal = total ?? this.contextTotal;
    this.syncPrompt();
    this.patchSidebarData({
      context: { used, total: this.contextTotal },
      server: { nCtx: this.contextTotal },
    });
  }

  context(): { used?: number; total?: number } {
    return { used: this.contextUsed, total: this.contextTotal };
  }

  // ---- transcript -------------------------------------------------------

  addUser(text: string): void {
    this.transcript.addUser(text);
    this.transcript.scrollToBottom();
    this.syncPrompt();
  }

  addNotice(text: string): void {
    this.transcript.addNotice(text);
  }

  beginAssistant(): AssistantStream & { text(): string } {
    const message: ActiveAssistantMessage = this.transcript.beginAssistant();
    this.setBusy(true);
    return {
      pushThinking: (token) => message.pushThinking(token),
      push: (token) => message.push(token),
      text: () => message.text(),
      done: (detail) => {
        this.setBusy(false);
        message.done(detail);
      },
    };
  }

  scroll(command: ScrollCommand): void {
    this.transcript.scrollByRows(scrollDelta(this.transcript.viewportHeight(), command));
  }

  scrollTop(): void {
    this.transcript.scrollToTop();
  }

  scrollBottom(): void {
    this.transcript.scrollToBottom();
  }

  transcriptEmpty(): boolean {
    return this.transcript.isEmpty();
  }

  // ---- config modal -----------------------------------------------------

  configIsOpen(): boolean {
    return this.configOpen;
  }

  showConfig(cfg: LaunchConfig): void {
    this.configOpen = true;
    this.configScrim.visible = true;
    this.prompt.blur();
    this.configText.content = configOverlayText(cfg);
  }

  hideConfig(): void {
    this.configOpen = false;
    this.configScrim.visible = false;
  }

  destroy(): void {
    this.transcript.destroy();
    this.prompt.destroy();
    this.sidebar.destroy();
    if (!this.renderer.isDestroyed) this.configScrim.destroy();
  }
}

// The in-chat overlay shows the context group in full (it is the only group
// that ships a value) and only the parameters that were moved off llama.cpp's
// default, so the block always fits without scrolling. Every line is produced
// by `fieldDisplay`, so the overlay cannot drift from the editor.
export function configOverlayText(cfg: LaunchConfig): string {
  const lines: string[] = [`Model    ${modelDisplayName(cfg.model)}`];
  const changed = new Map<ConfigFieldGroup, string[]>();
  for (const def of CONFIG_FIELDS) {
    if (def.group === "context") {
      const contextRows = changed.get(def.group) ?? [];
      contextRows.push(`${def.label}: ${fieldDisplay(cfg, def)}`);
      changed.set(def.group, contextRows);
      continue;
    }
    if (!def.optional) continue; // addresses, always shown in their own line
    if (isDefaultState(cfg, def)) continue;
    const rows = changed.get(def.group) ?? [];
    rows.push(`${def.label}: ${fieldDisplay(cfg, def)}`);
    changed.set(def.group, rows);
  }
  for (const group of CONFIG_GROUP_ORDER) {
    const rows = changed.get(group);
    if (!rows || rows.length === 0) continue;
    lines.push(`${CONFIG_GROUP_TITLES[group]}  ${rows.join("  ")}`);
  }
  lines.push(`server   ${cfg.host}:${cfg.port}   (? opens the manual)`);
  return lines.join("\n");
}

// A parameter is at its default state when nothing is sent for it, which for
// every optional field is `null`.
function isDefaultState(cfg: LaunchConfig, def: ConfigFieldDef): boolean {
  return (cfg as unknown as Record<string, unknown>)[def.key] === null;
}

export function emptySidebarData(cfg?: LaunchConfig): SidebarData {
  return {
    model: {
      name: cfg ? modelDisplayName(cfg.model) : "(no model)",
      source: cfg?.model?.kind === "hf" ? "huggingface" : "local",
      ctxSize: cfg?.ctxSize ?? 0,
      gpuLayers: cfg?.gpuLayers ?? null,
      temp: cfg?.temp ?? null,
      topP: cfg?.topP ?? null,
      topK: cfg?.topK ?? null,
      thinking: cfg?.thinking ?? null,
      reasoning: cfg?.reasoning ?? null,
    },
    server: {
      baseUrl: "",
      slotId: 0,
      props: cfg?.enableProps ?? null,
      metrics: cfg?.enableMetrics ?? null,
      processing: false,
    },
    context: {},
    gpu: [],
    system: { cpuPct: 0, perCorePct: [], memUsedMiB: 0, memTotalMiB: 0, load1: 0 },
  };
}
