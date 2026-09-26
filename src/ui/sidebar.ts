import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { hbar, pct } from "../ascii.js";
import { SIDEBAR_WIDTH, type SidebarMode } from "./layout.js";
import type { UiTheme } from "./theme.js";

export type SidebarSectionId = "context" | "model" | "server" | "system";

export interface SidebarData {
  model: {
    name: string;
    source: string;
    ctxSize: number;
    gpuLayers: string;
    /** Sampling values are nullable: a parameter the user switched off. */
    temp: number | null;
    topP: number | null;
    topK: number | null;
    reasoning: string;
  };
  server: {
    baseUrl: string;
    slotId: number;
    nCtx?: number;
    props: boolean;
    metrics: boolean;
    processing: boolean;
    tokPerSecond?: number;
  };
  context: { used?: number; total?: number };
  system: {
    cpuPct: number;
    perCorePct: number[];
    memUsedMiB: number;
    memTotalMiB: number;
    load1: number;
  };
}

export const SIDEBAR_SECTION_ORDER: SidebarSectionId[] = ["context", "model", "server", "system"];

const SECTION_TITLES: Record<SidebarSectionId, string> = {
  context: "Context",
  model: "Model",
  server: "Server",
  system: "System",
};

const UNKNOWN = "--";
// The ScrollBox keeps a track column plus its 1-column gutter on the right
// whenever the content overflows, so rows are laid out for the narrower box and
// never clip on the first overflowing frame.
const FULL_WIDTH = SIDEBAR_WIDTH - 6;
const LABEL_WIDTH = 9;
const VALUE_WIDTH = FULL_WIDTH - LABEL_WIDTH;
const CONTEXT_BAR_WIDTH = 24;
const METER_BAR_WIDTH = 12;
const CORE_BAR_WIDTH = 10;
const MAX_CORES = 8;
const CURSOR_SLOT = "❯ ";
const IDLE_CURSOR_SLOT = "  ";
const EXPANDED_MARKER = "▾";
const COLLAPSED_MARKER = "▸";
const SCRIM_Z = 100;

export type RowTone = "text" | "accent" | "muted";

export interface SidebarRow {
  label: string;
  value: string;
  tone?: RowTone;
  /** Bar and overflow rows span the panel instead of using the label column. */
  wide?: boolean;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return UNKNOWN;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatSidebarContext(used?: number, total?: number): string {
  const knownTotal = total !== undefined && Number.isFinite(total) && total > 0 ? total : undefined;
  const knownUsed = used !== undefined && Number.isFinite(used) ? used : undefined;
  if (knownUsed === undefined) return knownTotal === undefined ? UNKNOWN : formatCount(knownTotal);
  if (knownTotal === undefined) return formatCount(knownUsed);
  return `${formatCount(knownUsed)} (${pct(knownUsed / knownTotal)})`;
}

export function sidebarContextFraction(context: SidebarData["context"]): number {
  return context.used !== undefined && context.total !== undefined && context.total > 0
    ? context.used / context.total
    : 0;
}

export function formatContextRows(context: SidebarData["context"]): SidebarRow[] {
  const knownTotal = context.total !== undefined && context.total > 0 ? context.total : undefined;
  const used = context.used;
  const fraction = sidebarContextFraction(context);
  const rows: SidebarRow[] = [
    { label: "Context", value: used === undefined ? UNKNOWN : `${formatCount(used)} tokens` },
    {
      label: "used",
      value: used === undefined || knownTotal === undefined ? UNKNOWN : pct(fraction),
    },
    {
      label: "",
      value: used === undefined || knownTotal === undefined ? UNKNOWN : hbar(fraction, CONTEXT_BAR_WIDTH),
      wide: true,
    },
  ];
  if (knownTotal !== undefined) rows.push({ label: "limit", value: formatCount(knownTotal) });
  return rows;
}

function optionalValue(value: number | null): string {
  return value === null ? "off" : String(value);
}

export function formatModelRows(model: SidebarData["model"]): SidebarRow[] {
  return [
    { label: "name", value: model.name },
    { label: "source", value: model.source },
    { label: "ctx", value: model.ctxSize > 0 ? String(model.ctxSize) : "model" },
    { label: "ngl", value: model.gpuLayers },
    { label: "temp", value: optionalValue(model.temp) },
    { label: "top-p", value: optionalValue(model.topP) },
    { label: "top-k", value: optionalValue(model.topK) },
    { label: "think", value: model.reasoning },
  ];
}

export function formatServerRows(server: SidebarData["server"]): SidebarRow[] {
  return [
    { label: "url", value: server.baseUrl },
    {
      label: "slot",
      value: `${server.slotId} · ${server.processing ? "busy" : "idle"}`,
      tone: server.processing ? "accent" : "muted",
    },
    { label: "n_ctx", value: server.nCtx === undefined ? UNKNOWN : String(server.nCtx) },
    { label: "props", value: server.props ? "on" : "off" },
    { label: "metrics", value: server.metrics ? "on" : "off" },
    {
      label: "tok/s",
      value: server.tokPerSecond === undefined ? UNKNOWN : server.tokPerSecond.toFixed(1),
    },
  ];
}

export function formatSystemRows(system: SidebarData["system"]): SidebarRow[] {
  const memFrac = system.memTotalMiB > 0 ? system.memUsedMiB / system.memTotalMiB : 0;
  const rows: SidebarRow[] = [
    { label: "CPU", value: `${pct(system.cpuPct)} [${hbar(system.cpuPct, METER_BAR_WIDTH)}]` },
  ];
  system.perCorePct.slice(0, MAX_CORES).forEach((core, index) => {
    rows.push({ label: `c${index}`, value: `[${hbar(core, CORE_BAR_WIDTH)}]` });
  });
  if (system.perCorePct.length > MAX_CORES) {
    rows.push({ label: "", value: `… +${system.perCorePct.length - MAX_CORES} cores`, wide: true });
  }
  rows.push({ label: "MEM", value: `${pct(memFrac)} [${hbar(memFrac, METER_BAR_WIDTH)}]` });
  rows.push({ label: "used", value: `${system.memUsedMiB} / ${system.memTotalMiB} MiB` });
  rows.push({ label: "load", value: system.load1.toFixed(2) });
  return rows;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

interface Section {
  id: SidebarSectionId;
  box: BoxRenderable;
  header: BoxRenderable;
  cursorSlot: TextRenderable;
  marker: TextRenderable;
  title: TextRenderable;
  body: BoxRenderable;
  texts: TextRenderable[];
  collapsed: boolean;
}

export class SidePanel {
  readonly body: BoxRenderable;
  private readonly renderer: CliRenderer;
  private readonly theme: UiTheme;
  private readonly scrim: BoxRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly sections: Section[];
  private readonly onDismiss: (() => void) | undefined;
  private host: Renderable | null = null;
  private cursor = 0;
  private cursorVisible = false;
  private focusOrigin: Renderable | null = null;
  private mode: SidebarMode = "hidden";
  private hover: Section | null = null;

  constructor(renderer: CliRenderer, theme: UiTheme, onDismiss?: () => void) {
    this.renderer = renderer;
    this.theme = theme;
    this.onDismiss = onDismiss;
    this.body = new BoxRenderable(renderer, {
      id: "sidebar",
      width: SIDEBAR_WIDTH,
      height: "100%",
      flexShrink: 0,
      alignSelf: "stretch",
      flexDirection: "column",
      backgroundColor: theme.panel,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      position: "relative",
      visible: false,
    });
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: "sidebar-scroll",
      // The ScrollBox root is a row holding the viewport plus the scrollbar;
      // overriding flexDirection stacks the bar under the content instead.
      // Options go through the constructor so the bar keeps OpenTUI's
      // auto-hide behaviour and only paints when the panel overflows.
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 0,
      width: "100%",
      verticalScrollbarOptions: {
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: theme.panel,
          foregroundColor: theme.borderActive,
        },
      },
    });
    this.body.add(this.scroll);
    this.sections = SIDEBAR_SECTION_ORDER.map((id, index) => this.createSection(id, index));
    for (const section of this.sections) this.scroll.add(section.box);

    this.scrim = new BoxRenderable(renderer, {
      id: "sidebar-scrim",
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: "row",
      // A row scrim right-aligns its child on the main axis, so the panel needs
      // justifyContent; alignItems only handles the cross axis (its height).
      alignItems: "flex-end",
      justifyContent: "flex-end",
      backgroundColor: "#000000b0",
      zIndex: SCRIM_Z,
      visible: false,
    });
    this.scrim.onMouseDown = (event) => {
      event.stopPropagation();
      this.onDismiss?.();
    };
    this.body.onMouseDown = (event) => {
      event.stopPropagation();
    };
  }

  setMode(mode: SidebarMode): void {
    this.mode = mode;
    if (this.body.parent !== null && this.body.parent !== this.scrim) this.host = this.body.parent;
    if (mode === "overlay") {
      if (this.scrim.parent !== this.renderer.root) this.renderer.root.add(this.scrim);
      this.scrim.visible = true;
      this.body.visible = true;
      if (this.body.parent !== this.scrim) this.scrim.add(this.body);
      this.body.position = "relative";
      this.body.zIndex = SCRIM_Z + 1;
      return;
    }
    this.scrim.visible = false;
    if (this.scrim.parent) this.scrim.parent.remove(this.scrim);
    this.body.zIndex = 0;
    if (this.body.parent === this.scrim) {
      if (this.host) this.host.add(this.body);
      else this.scrim.remove(this.body);
    }
    this.body.visible = mode !== "hidden";
    if (mode === "hidden") this.releaseCursorFocus();
  }

  currentMode(): SidebarMode {
    return this.mode;
  }

  setData(data: SidebarData): void {
    const rows: Record<SidebarSectionId, SidebarRow[]> = {
      context: formatContextRows(data.context),
      model: formatModelRows(data.model),
      server: formatServerRows(data.server),
      system: formatSystemRows(data.system),
    };
    for (const section of this.sections) {
      const wanted = rows[section.id];
      this.resizeRows(section, wanted.length);
      wanted.forEach((row, index) => this.paintRow(section.texts[index]!, row));
    }
  }

  setSectionCollapsed(id: SidebarSectionId, collapsed: boolean): void {
    const section = this.sectionOf(id);
    if (section.collapsed === collapsed) return;
    section.collapsed = collapsed;
    this.syncSection(section);
  }

  isSectionCollapsed(id: SidebarSectionId): boolean {
    return this.sectionOf(id).collapsed;
  }

  toggleSection(id: SidebarSectionId): void {
    this.setSectionCollapsed(id, !this.sectionOf(id).collapsed);
  }

  moveCursor(delta: 1 | -1): void {
    if (!this.cursorVisible) return;
    const count = this.sections.length;
    this.cursor = (this.cursor + delta + count) % count;
    this.syncCursor();
  }

  activateCursor(): SidebarSectionId | null {
    if (!this.cursorVisible) return null;
    const id = this.cursorId();
    this.toggleSection(id);
    return id;
  }

  cursorId(): SidebarSectionId {
    return this.sections[this.cursor]?.id ?? "context";
  }

  isCursorVisible(): boolean {
    return this.cursorVisible;
  }

  setCursorVisible(visible: boolean): void {
    if (this.cursorVisible === visible) return;
    this.cursorVisible = visible;
    if (visible) {
      this.claimCursorFocus();
      this.syncCursor();
      return;
    }
    this.releaseCursorFocus();
    this.syncCursor();
  }

  scrollBy(rows: number): void {
    this.scroll.scrollBy(rows);
  }

  scrollToTop(): void {
    this.scroll.scrollTo(0);
  }

  destroy(): void {
    this.host = null;
    this.focusOrigin = null;
    if (this.renderer.isDestroyed) return;
    this.releaseCursorFocus();
    for (const section of this.sections) {
      if (!section.box.isDestroyed) section.box.destroy();
    }
    if (!this.body.isDestroyed) this.body.destroy();
    if (!this.scrim.isDestroyed) this.scrim.destroy();
  }

  private sectionOf(id: SidebarSectionId): Section {
    const section = this.sections.find((entry) => entry.id === id);
    if (!section) throw new Error(`unknown sidebar section: ${id}`);
    return section;
  }

  private createSection(id: SidebarSectionId, index: number): Section {
    const section = {
      id,
      box: undefined as unknown as BoxRenderable,
      header: undefined as unknown as BoxRenderable,
      cursorSlot: undefined as unknown as TextRenderable,
      marker: undefined as unknown as TextRenderable,
      title: undefined as unknown as TextRenderable,
      body: undefined as unknown as BoxRenderable,
      texts: [] as TextRenderable[],
      collapsed: false,
    };
    const box = new BoxRenderable(this.renderer, {
      id: `sidebar-section-${id}`,
      flexDirection: "column",
      flexShrink: 0,
      width: "100%",
      marginTop: index === 0 ? 0 : 1,
    });
    const header = new BoxRenderable(this.renderer, {
      id: `sidebar-header-${id}`,
      flexDirection: "row",
      flexShrink: 0,
      width: "100%",
      height: 1,
      gap: 1,
      focusable: true,
    });
    section.header = header;
    section.cursorSlot = this.text(`sidebar-cursor-${id}`, CURSOR_SLOT, this.theme.accent, 2);
    section.marker = this.text(`sidebar-marker-${id}`, EXPANDED_MARKER, this.theme.accent, 1);
    section.title = this.text(`sidebar-title-${id}`, SECTION_TITLES[id], this.theme.text);
    header.add(section.cursorSlot);
    header.add(section.marker);
    header.add(section.title);
    header.onMouseDown = (event) => {
      event.stopPropagation();
      if (this.cursorVisible) this.focusSection(section);
      this.toggleSection(section.id);
    };
    header.onMouseOver = () => {
      this.hover = section;
      this.paintHeader(section);
    };
    header.onMouseOut = () => {
      if (this.hover === section) this.hover = null;
      this.paintHeader(section);
    };
    const body = new BoxRenderable(this.renderer, {
      id: `sidebar-body-${id}`,
      flexDirection: "column",
      flexShrink: 0,
      width: "100%",
    });
    section.body = body;
    section.box = box;
    box.add(header);
    box.add(body);
    this.syncSection(section);
    return section;
  }

  private text(id: string, content: string, color: string, width?: number): TextRenderable {
    const text = new TextRenderable(this.renderer, {
      id,
      content,
      ...(width === undefined ? {} : { width }),
    });
    // A constructor `wrapMode` makes the node measure to width 0 before Yoga
    // constrains it, so it never paints; only set it after construction.
    text.wrapMode = "none";
    text.fg = color;
    return text;
  }

  private resizeRows(section: Section, count: number): void {
    while (section.texts.length > count) {
      const extra = section.texts.pop();
      if (extra) {
        section.body.remove(extra);
        extra.destroy();
      }
    }
    while (section.texts.length < count) {
      const text = this.text(`sidebar-row-${section.id}-${section.texts.length}`, "", this.theme.muted);
      text.selectable = false;
      section.body.add(text);
      section.texts.push(text);
    }
  }

  private paintRow(text: TextRenderable, row: SidebarRow): void {
    const tone = row.tone ?? "text";
    const value = tone === "text" ? this.theme.text : tone === "accent" ? this.theme.accent : this.theme.muted;
    if (row.wide) {
      text.content = new StyledText([fg(this.theme.muted)(truncate(row.value, FULL_WIDTH))]);
      return;
    }
    const label = truncate(row.label.padEnd(LABEL_WIDTH), LABEL_WIDTH);
    text.content = new StyledText([fg(this.theme.muted)(label), fg(value)(truncate(row.value, VALUE_WIDTH))]);
  }

  private syncSection(section: Section): void {
    section.body.visible = !section.collapsed;
    this.paintHeader(section);
  }

  private paintHeader(section: Section): void {
    const active = this.cursorVisible && this.sections[this.cursor]?.id === section.id;
    const hovered = this.hover === section;
    section.cursorSlot.content = active ? CURSOR_SLOT : IDLE_CURSOR_SLOT;
    section.marker.content = section.collapsed ? COLLAPSED_MARKER : EXPANDED_MARKER;
    section.title.fg =
      section.collapsed && !active && !hovered ? this.theme.muted : active ? this.theme.accent : this.theme.text;
  }

  private syncCursor(): void {
    for (const section of this.sections) this.paintHeader(section);
    if (this.cursorVisible) this.focusSection(this.sections[this.cursor]!);
  }

  private focusSection(section: Section): void {
    if (section.header.focused) return;
    const current = this.renderer.currentFocusedRenderable;
    if (current && current !== section.header) current.blur();
    section.header.focus();
  }

  private claimCursorFocus(): void {
    const current = this.renderer.currentFocusedRenderable;
    this.focusOrigin = current && !this.owns(current) ? current : null;
  }

  private releaseCursorFocus(): void {
    const current = this.renderer.currentFocusedRenderable;
    if (current && this.owns(current)) current.blur();
    const origin = this.focusOrigin;
    this.focusOrigin = null;
    if (!origin || origin.isDestroyed) return;
    const active = this.renderer.currentFocusedRenderable;
    if (active === null || this.owns(active)) origin.focus();
  }

  private owns(renderable: Renderable): boolean {
    if (renderable === this.body || renderable === this.scrim || renderable === this.scroll) return true;
    return this.sections.some((section) => section.header === renderable);
  }
}
