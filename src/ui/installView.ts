// The `bun run install` wizard. Same visual language as the app: monochrome
// surfaces, frameless left-ruled sections, the block wordmark, and the shared
// gradient meter for anything that has a size. One bottom footer carries the
// key reference and the step counter, exactly like the pre-chat screens.
//
// The view is presentational: it renders what it is told and reports intent
// through InstallViewEvents. The state machine lives in ../../install.ts.

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextRenderable,
} from "@opentui/core";
import { formatGiB, simdSummary, type Backend, type BackendOption, type Hardware } from "../backends.js";
import { abbreviateHome } from "../config.js";
import { formatBytes } from "../paths.js";
import type { SplashFrame } from "../splash.js";
import { staticText, surface } from "./components.js";
import { isEnterKey, isEscapeKey, isQuitKey } from "./keys.js";
import { gradientFill, meterTokens, sweepFill } from "./meter.js";
import { SplashView } from "./splashView.js";
import { DARK_THEME, type UiTheme } from "./theme.js";

export type InstallStep = "splash" | "hardware" | "backend" | "models" | "install" | "path" | "summary";

/** Steps the footer counts. `path` is dropped when PATH already has the dir. */
export const STEP_ORDER: InstallStep[] = ["hardware", "backend", "models", "install", "path", "summary"];

const STEP_LABELS: Record<InstallStep, string> = {
  splash: "",
  hardware: "hardware",
  backend: "backend",
  models: "models",
  install: "install",
  path: "path",
  summary: "ready",
};

const HINTS: Record<InstallStep, string> = {
  splash: "",
  hardware: "enter continue · r rescan · Ctrl+C quit",
  backend: "↑/↓ pick · enter install it · Ctrl+C quit",
  models: "enter accept · esc back · Ctrl+C quit",
  install: "esc cancel the download",
  path: "↑/↓ pick · enter confirm · Ctrl+C quit",
  summary: "enter start lazyllama · esc close",
};

const COMPACT_HINTS: Partial<Record<InstallStep, string>> = {
  hardware: "enter continue · Ctrl+C quit",
  backend: "↑/↓ pick · enter install",
  models: "enter accept · esc back",
  install: "esc cancel",
  path: "↑/↓ pick · enter",
  summary: "enter start · esc close",
};

const CONTENT_WIDTH = 76;
const LABEL_WIDTH = 12;
const FOOTER_SIDE_PADDING = 4;
const FOOTER_GAP = 2;
const METER_COLUMNS = 14;
const SELECTED_MARKER = "▸";
const PLAIN_MARKER = " ";

export interface InstallViewEvents {
  onBackendPick(id: Backend): void;
  onModelsDirInput(raw: string): void;
  onModelsDirSubmit(raw: string): void;
  onPathAnswer(append: boolean): void;
  onAdvance(): void;
  onLaunch(): void;
  onCancelInstall(): void;
  onRescan(): void;
  onBack(): void;
  onQuit(): void;
}

export interface Row {
  label: string;
  value: string;
  /** 0..1: render a gradient meter after the value. */
  bar?: number;
  tone?: "normal" | "muted" | "accent";
}

export interface ModelsDirState {
  raw: string;
  resolved: string;
  exists: boolean;
  writable: boolean;
  freeBytes?: number;
  usedFraction?: number;
  ggufCount: number;
  created?: boolean;
  error?: string;
}

export interface PathState {
  shim: string;
  binDir: string;
  onPath: boolean;
  shell: string;
  rc: string;
  line: string;
  /** Set once the user answered: whether the line was appended. */
  appended?: boolean;
}

export interface SummarySection {
  title: string;
  rows: Row[];
}

/** Footer hints never overlap the step counter: shorten or drop them. */
export function installHints(width: number, step: InstallStep, meta: string): string {
  const available = width - FOOTER_SIDE_PADDING - FOOTER_GAP - meta.length;
  const full = HINTS[step];
  if (full.length <= available) return full;
  const compact = COMPACT_HINTS[step];
  if (compact !== undefined && compact.length <= available) return compact;
  return "";
}

/** The hardware survey as label/value rows, with a real RAM meter. */
export function hardwareRows(hw: Hardware): Row[] {
  const rows: Row[] = [{ label: "os", value: `${hw.prettyOs} (${hw.arch})` }];
  if (hw.cpuModel.length > 0) rows.push({ label: "cpu", value: hw.cpuModel });
  rows.push({ label: "threads", value: `${hw.cores} · ${simdSummary(hw)}` });
  rows.push({
    label: "gpu",
    value: hw.gpus.length > 0 ? hw.gpus.map((gpu) => gpu.name).join(" · ") : "none detected",
    tone: hw.gpus.length > 0 ? "normal" : "muted",
  });
  if (hw.nvidiaDriverMajor !== undefined) {
    rows.push({ label: "driver", value: `nvidia ${hw.nvidiaDriverMajor}` });
  }
  rows.push({
    label: "vulkan",
    value: !hw.hasVulkanLoader
      ? "no loader"
      : hw.vulkanDevices.length > 0
        ? hw.vulkanDevices.join(" · ")
        : "loader present, no devices",
    tone: hw.vulkanDevices.length > 0 ? "normal" : "muted",
  });
  rows.push({
    label: "ram",
    value: hw.totalMemBytes > 0 ? `${formatGiB(hw.usedMemBytes)} / ${formatGiB(hw.totalMemBytes)}` : "--",
    bar: hw.totalMemBytes > 0 ? Math.min(1, hw.usedMemBytes / hw.totalMemBytes) : undefined,
  });
  return rows;
}

/** One line per backend: the recommended one is marked, blocked states the why. */
export function backendRow(option: BackendOption): string {
  const marker = option.recommended ? SELECTED_MARKER : PLAIN_MARKER;
  const note = option.blockers[0] ?? option.def.blurb;
  return `${marker} ${option.def.label} · ${note}`.trimEnd();
}

/** Everything the highlighted backend needs to know, under the list. */
export function backendDetail(option: BackendOption): Row[] {
  const rows: Row[] = [
    {
      label: "download",
      value: option.def.approxMiB > 0 ? `~${option.def.approxMiB} MiB prebuilt` : "nothing to download, compiles locally",
    },
  ];
  if (option.def.minNvidiaDriver !== undefined) {
    rows.push({ label: "requires", value: `nvidia driver >= ${option.def.minNvidiaDriver}` });
  }
  if (option.reasons.length > 0) rows.push({ label: "detected", value: option.reasons.join("; ") });
  if (option.blockers.length > 0) rows.push({ label: "blocked", value: option.blockers.join("; "), tone: "muted" });
  if (option.fallback.length > 0) rows.push({ label: "fallback", value: option.fallback.join(" → "), tone: "muted" });
  return rows;
}

function modelsRows(state: ModelsDirState): Row[] {
  const rows: Row[] = [
    { label: "path", value: abbreviateHome(state.resolved) },
    {
      label: "status",
      value: state.error
        ? state.error
        : state.created
          ? "created"
          : state.exists
            ? state.writable
              ? "already there, writable"
              : "already there, not writable"
            : "will be created",
      tone: state.error || !state.writable || (!state.exists && !state.created) ? "muted" : "normal",
    },
  ];
  if (state.freeBytes !== undefined && state.usedFraction !== undefined) {
    rows.push({ label: "free", value: `${formatBytes(state.freeBytes)} free`, bar: state.usedFraction });
  }
  rows.push({
    label: "models",
    value: state.ggufCount === 0 ? "no .gguf files yet" : `${state.ggufCount} .gguf found`,
    tone: state.ggufCount === 0 ? "muted" : "normal",
  });
  return rows;
}

/**
 * A fixed pool of `label  value` lines. Rebinding content in place keeps ids
 * stable and avoids tearing down renderables on every keystroke, which is what
 * the live models-directory readout would otherwise do on each character.
 */
class RowList {
  private readonly entries: Array<{
    box: BoxRenderable;
    label: TextRenderable;
    value: TextRenderable;
  }> = [];

  constructor(
    renderer: CliRenderer,
    private readonly parent: BoxRenderable,
    private readonly prefix: string,
    capacity: number,
    private readonly theme: UiTheme,
  ) {
    for (let i = 0; i < capacity; i += 1) {
      // No fixed height: a value that needs two rows grows the line instead of
      // being clipped, which matters for paths and long GPU names.
      const box = new BoxRenderable(renderer, {
        id: `${prefix}-row-${i}`,
        flexDirection: "row",
        width: "100%",
        flexShrink: 0,
        alignItems: "flex-start",
        visible: false,
      });
      const label = staticText(renderer, {
        id: `${prefix}-row-${i}-label`,
        content: "",
        fg: theme.muted,
        wrapMode: "none",
      });
      const value = staticText(renderer, { id: `${prefix}-row-${i}-value`, content: "", wrapMode: "word" });
      // Yoga defaults flexShrink to 0, so a value that wraps needs to be told
      // it may give up width to the label beside it.
      value.flexShrink = 1;
      value.minWidth = 0;
      box.add(label);
      box.add(value);
      this.parent.add(box);
      this.entries.push({ box, label, value });
    }
  }

  set(rows: Row[], theme: UiTheme): void {
    for (const [index, entry] of this.entries.entries()) {
      const row = rows[index];
      if (row === undefined) {
        entry.box.visible = false;
        continue;
      }
      entry.box.visible = true;
      // An empty label is a section heading: keep it flush instead of padding
      // it into the value column.
      entry.label.content = row.label.length > 0 ? row.label.padEnd(LABEL_WIDTH, " ") : "";
      const color = row.tone === "muted" ? theme.muted : row.tone === "accent" ? theme.accent : theme.text;
      entry.value.fg = color;
      // A path has no spaces to wrap at, so it needs character wrapping;
      // prose keeps word wrapping so it never breaks mid-word.
      entry.value.wrapMode = /\s/.test(row.value) ? "word" : "char";
      entry.value.content =
        row.bar !== undefined
          ? new StyledText([fg(color)(`${row.value}  `), ...gradientFill(row.bar, METER_COLUMNS, meterTokens(theme))])
          : row.value;
    }
  }
}

export class InstallView {
  readonly root: BoxRenderable;
  readonly splash: SplashView;
  private readonly renderer: CliRenderer;
  private readonly theme: UiTheme;
  private readonly events: InstallViewEvents;
  private readonly scrollWrap: BoxRenderable;
  private readonly column: BoxRenderable;
  private readonly splashWrap: BoxRenderable;
  private readonly hints: TextRenderable;
  private readonly meta: TextRenderable;
  private readonly sections = new Map<InstallStep, BoxRenderable>();
  private readonly hardware: RowList;
  private readonly backendSelect: SelectRenderable;
  private readonly backendDetailRows: RowList;
  private readonly modelsInput: InputRenderable;
  private readonly modelsRowsList: RowList;
  private readonly installLabel: TextRenderable;
  private readonly installBar: TextRenderable;
  private readonly installDetail: TextRenderable;
  private readonly pathRowsList: RowList;
  private readonly pathSelect: SelectRenderable;
  private readonly summaryRows: RowList;
  private backendOptions: BackendOption[] = [];
  private stepNames: InstallStep[] = STEP_ORDER;
  private current: InstallStep = "splash";

  constructor(renderer: CliRenderer, events: InstallViewEvents, theme: UiTheme = DARK_THEME) {
    this.renderer = renderer;
    this.theme = theme;
    this.events = events;

    this.root = new BoxRenderable(renderer, {
      id: "install-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    });
    this.scrollWrap = new BoxRenderable(renderer, {
      id: "install-scroll-wrap",
      flexGrow: 1,
      minHeight: 0,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    });
    // The ScrollBox root stays a row (viewport plus scrollbar side by side) and
    // takes its scrollbar options in the constructor, which leaves the bar's
    // manual-visibility flag unset so it auto-hides when everything fits.
    const scroller = new ScrollBoxRenderable(renderer, {
      id: "install-scroll",
      flexGrow: 1,
      minHeight: 0,
      // Constructor, not the property setter: the setter marks the bar as
      // manually controlled and pins it on screen even when everything fits.
      verticalScrollbarOptions: {
        paddingLeft: 1,
        trackOptions: { backgroundColor: theme.panel, foregroundColor: theme.border },
      },
    });
    this.column = new BoxRenderable(renderer, {
      id: "install-column",
      flexDirection: "column",
      width: CONTENT_WIDTH,
      alignSelf: "center",
      flexShrink: 0,
    });
    scroller.add(this.column);
    this.scrollWrap.add(scroller);

    this.splashWrap = new BoxRenderable(renderer, { id: "install-splash-wrap", flexGrow: 1, minHeight: 0 });
    this.splash = new SplashView(renderer, theme);
    this.splashWrap.add(this.splash.body);

    // -- hardware
    const hardwareSection = this.section("install-hardware", "detected hardware", "hardware");
    const hardwareBody = this.rowBox("install-hardware-body");
    this.hardware = new RowList(renderer, hardwareBody, "install-hardware", 8, theme);
    hardwareSection.add(hardwareBody);

    // -- backend
    const backendSection = this.section("install-backend", "backend", "backend");
    this.backendSelect = this.createSelect("install-backends", (index) => {
      const option = this.backendOptions[index];
      if (option) events.onBackendPick(option.def.id);
    });
    this.backendSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => this.syncBackendDetail());
    const backendBody = this.rowBox("install-backend-body");
    this.backendDetailRows = new RowList(renderer, backendBody, "install-backend-detail", 6, theme);
    backendSection.add(this.backendSelect);
    backendSection.add(this.spacer("install-backend-gap"));
    backendSection.add(backendBody);

    // -- models
    const modelsSection = this.section("install-models", "models directory", "models");
    this.modelsInput = new InputRenderable(renderer, {
      id: "install-models-input",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
    });
    this.modelsInput.on(InputRenderableEvents.INPUT, () => events.onModelsDirInput(this.modelsInput.value));
    this.modelsInput.on(InputRenderableEvents.ENTER, () => events.onModelsDirSubmit(this.modelsInput.value));
    const modelsBody = this.rowBox("install-models-body");
    this.modelsRowsList = new RowList(renderer, modelsBody, "install-models", 6, theme);
    const inputRow = new BoxRenderable(renderer, { id: "install-models-input-row", flexDirection: "row", width: "100%" });
    inputRow.add(staticText(renderer, { id: "install-models-marker", content: `${SELECTED_MARKER} `, fg: theme.accent }));
    inputRow.add(this.modelsInput);
    modelsSection.add(inputRow);
    modelsSection.add(this.spacer("install-models-gap"));
    modelsSection.add(modelsBody);

    // -- install
    const installSection = this.section("install-progress", "installing", "install");
    this.installLabel = staticText(renderer, {
      id: "install-label",
      content: "",
      fg: theme.text,
      wrapMode: "word",
      width: "100%",
    });
    this.installBar = staticText(renderer, { id: "install-bar", content: "", wrapMode: "none" });
    this.installDetail = staticText(renderer, {
      id: "install-detail",
      content: "",
      fg: theme.muted,
      wrapMode: "word",
      width: "100%",
    });
    installSection.add(this.installLabel);
    installSection.add(this.installBar);
    installSection.add(this.installDetail);

    // -- path
    const pathSection = this.section("install-path", "add lazyllama to your PATH", "path");
    const pathBody = this.rowBox("install-path-body");
    this.pathRowsList = new RowList(renderer, pathBody, "install-path", 6, theme);
    this.pathSelect = this.createSelect("install-path-choice", (index) => events.onPathAnswer(index === 0));
    pathSection.add(pathBody);
    pathSection.add(this.spacer("install-path-gap"));
    pathSection.add(this.pathSelect);

    // -- summary
    const summarySection = this.section("install-summary-section", "ready", "summary");
    const summaryBody = this.rowBox("install-summary-body");
    this.summaryRows = new RowList(renderer, summaryBody, "install-summary", 16, theme);
    summarySection.add(summaryBody);

    const footer = new BoxRenderable(renderer, {
      id: "install-footer",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 2,
      paddingRight: 2,
      flexShrink: 0,
    });
    this.hints = staticText(renderer, { id: "install-hints", content: "", fg: theme.muted });
    this.meta = staticText(renderer, { id: "install-meta", content: "", fg: theme.muted });
    footer.add(this.hints);
    footer.add(this.meta);

    this.root.add(this.scrollWrap);
    this.root.add(this.splashWrap);
    this.root.add(footer);
    renderer.root.add(this.root);
    this.show("splash");
  }

  // -- construction helpers ----------------------------------------------

  private section(id: string, title: string, step: InstallStep): BoxRenderable {
    const box = surface(this.renderer, {
      id,
      backgroundColor: this.theme.panel,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      width: "100%",
      flexShrink: 0,
      rule: { sides: ["left"], color: this.theme.borderActive },
    });
    box.add(staticText(this.renderer, { id: `${id}-title`, content: title, fg: this.theme.accent, bold: true }));
    this.column.add(box);
    this.sections.set(step, box);
    return box;
  }

  private rowBox(id: string): BoxRenderable {
    return new BoxRenderable(this.renderer, {
      id,
      flexDirection: "column",
      width: "100%",
      flexShrink: 0,
    });
  }

  private spacer(id: string): BoxRenderable {
    return new BoxRenderable(this.renderer, { id, height: 1, width: "100%", flexShrink: 0 });
  }

  private createSelect(id: string, onPick: (index: number) => void): SelectRenderable {
    const select = new SelectRenderable(this.renderer, {
      id,
      flexGrow: 0,
      backgroundColor: this.theme.panel,
      textColor: this.theme.text,
      focusedBackgroundColor: this.theme.panel,
      focusedTextColor: this.theme.text,
      showDescription: false,
      showSelectionIndicator: false,
      showScrollIndicator: false,
      selectedTextColor: this.theme.accent,
      selectedBackgroundColor: this.theme.panel,
      wrapSelection: true,
      keyBindings: [
        { name: "enter", action: "select-current" },
        { name: "kpenter", action: "select-current" },
      ],
    });
    // SelectRenderable has no built-in mouse handling, so a click focuses it
    // and a click on a row picks that row.
    select.onMouseDown = (event) => {
      event.stopPropagation();
      select.focus();
    };
    select.onMouseUp = (event) => {
      event.stopPropagation();
      if (this.renderer.getSelection()?.getSelectedText()) return;
      const top = select.y;
      if (!Number.isFinite(top) || event.y < top) return;
      const row = Math.floor(event.y - top);
      if (row < 0 || row >= select.options.length) return;
      select.setSelectedIndex(row);
      onPick(row);
    };
    return select;
  }

  // -- step plumbing ------------------------------------------------------

  /**
   * Swap steps, retarget focus, repaint the footer.
   *
   * Focus is cleared on every change: a key that arrived while a slow step was
   * blocking must not be consumed by a control that is no longer on screen (an
   * Enter meant for the next step would otherwise commit the models field).
   */
  show(step: InstallStep, meta = ""): void {
    for (const [key, box] of this.sections) box.visible = key === step;
    this.splashWrap.visible = step === "splash";
    this.scrollWrap.visible = step !== "splash";
    this.current = step;
    this.syncFooter(meta);
    this.backendSelect.blur();
    this.modelsInput.blur();
    this.pathSelect.blur();
    if (step === "backend") this.backendSelect.focus();
    if (step === "models") this.modelsInput.focus();
    if (step === "path") this.pathSelect.focus();
  }

  get step(): InstallStep {
    return this.current;
  }

  /** Drop the PATH step from the counter when the dir is already on PATH. */
  setSteps(steps: InstallStep[]): void {
    this.stepNames = steps.filter((step) => step !== "splash");
  }

  private syncFooter(meta: string): void {
    const index = this.stepNames.indexOf(this.current);
    const stepMeta = index >= 0 ? `${index + 1}/${this.stepNames.length} ${STEP_LABELS[this.current]}` : meta;
    const right = meta.length > 0 ? `${stepMeta} · ${meta}` : stepMeta;
    this.meta.content = right;
    this.hints.content = installHints(this.renderer.terminalWidth, this.current, right);
  }

  /** Global keys. Non-Escape keys still reach the focused control first. */
  handleKey(key: KeyEvent): void {
    if (isQuitKey(key)) {
      this.events.onQuit();
      key.stopPropagation();
      return;
    }
    // The splash is a cutscene: only quitting is accepted while it plays.
    if (this.current === "splash") return;
    if (isEscapeKey(key)) {
      if (this.current === "install") this.events.onCancelInstall();
      else if (this.current === "models") this.events.onBack();
      else if (this.current === "summary") this.events.onQuit();
      key.stopPropagation();
      return;
    }
    if (this.current === "backend" && key.name === "r") {
      this.events.onRescan();
      key.stopPropagation();
      return;
    }
    // The models step is the one place a child control owns Enter: the input
    // needs it to commit. Everywhere else Enter is claimed here and turned into
    // intent, the same way the chat orchestrator claims it, so the wizard never
    // depends on a select's own key bindings matching this terminal's key name.
    if (isEnterKey(key) && this.current !== "models") {
      key.stopPropagation();
      key.preventDefault();
      if (this.current === "install") return;
      if (this.current === "summary") this.events.onLaunch();
      else if (this.current === "backend") {
        const option = this.backendOptions[this.backendSelect.getSelectedIndex()];
        if (option) this.events.onBackendPick(option.def.id);
      } else if (this.current === "path") {
        this.events.onPathAnswer(this.pathSelect.getSelectedIndex() === 0);
      } else this.events.onAdvance();
    }
  }

  // -- step content -------------------------------------------------------

  renderSplash(frame: SplashFrame): void {
    if (this.current === "splash") this.splash.render(frame);
  }

  setHardware(rows: Row[]): void {
    this.hardware.set(rows, this.theme);
  }

  setBackends(options: BackendOption[], selected?: Backend): void {
    this.backendOptions = options;
    this.backendSelect.options = options.map((option) => ({ name: backendRow(option), description: "" }));
    this.backendSelect.height = Math.max(1, options.length);
    const target = selected ?? options.find((option) => option.recommended)?.def.id ?? options[0]?.def.id;
    const index = Math.max(0, options.findIndex((option) => option.def.id === target));
    this.backendSelect.setSelectedIndex(index);
    this.syncBackendDetail();
  }

  private syncBackendDetail(): void {
    const option = this.backendOptions[this.backendSelect.getSelectedIndex()];
    if (option) this.backendDetailRows.set(backendDetail(option), this.theme);
  }

  setModelsDir(state: ModelsDirState): void {
    if (this.modelsInput.value !== state.raw) this.modelsInput.value = state.raw;
    this.modelsRowsList.set(modelsRows(state), this.theme);
  }

  setProgress(label: string, fraction: number | undefined, detail: string): void {
    this.installLabel.content = label;
    const width = Math.max(8, CONTENT_WIDTH - 6);
    // A known total gets the determinate gradient; an unknown one keeps
    // sweeping, exactly like the splash bar.
    this.installBar.content = new StyledText(
      fraction !== undefined ? gradientFill(fraction, width, meterTokens(this.theme)) : sweepFill(Date.now() % 6000, width, meterTokens(this.theme)),
    );
    this.installDetail.content = detail;
  }

  setPath(state: PathState): void {
    const rows: Row[] = [{ label: "launcher", value: abbreviateHome(state.shim) }];
    if (state.appended === undefined) {
      rows.push({ label: "shell", value: `${state.shell} reads ${abbreviateHome(state.rc)}` });
      rows.push({
        label: "path",
        value: state.onPath ? `${state.binDir} is already on your PATH` : `${state.binDir} is not on your PATH`,
        tone: state.onPath ? "normal" : "muted",
      });
      rows.push({ label: "line", value: state.line, tone: "accent" });
    } else {
      rows.push({
        label: state.appended ? "added" : "skipped",
        value: state.appended
          ? `yes · open a new shell or run: ${abbreviateHome(state.rc)}`
          : `add it yourself: ${state.line}`,
        tone: state.appended ? "normal" : "muted",
      });
    }
    this.pathRowsList.set(rows, this.theme);
    this.pathSelect.options = [
      { name: `${SELECTED_MARKER} append it to ${abbreviateHome(state.rc)}`, description: "" },
      { name: `${PLAIN_MARKER} no thanks, I will do it myself`, description: "" },
    ];
    this.pathSelect.height = 2;
    this.pathSelect.setSelectedIndex(0);
  }

  setSummary(sections: SummarySection[]): void {
    // Flattened into one ordered row list: titles ride along as accent rows so
    // the pool can never render a heading after its own values.
    const flat: Row[] = [];
    sections.forEach((section, index) => {
      flat.push({ label: "", value: section.title, tone: "accent" });
      flat.push(...section.rows);
      if (index < sections.length - 1) flat.push({ label: "", value: "" });
    });
    this.summaryRows.set(flat, this.theme);
  }
}
