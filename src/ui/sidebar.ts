import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  fg,
  type CliRenderer,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import { formatGiB, gibValue, pct } from "../ascii.js";
import type { GpuMemory } from "../vram.js";
import { SIDEBAR_WIDTH, type SidebarMode } from "./layout.js";
import { gradientFill, meterTokens } from "./meter.js";
import type { UiTheme } from "./theme.js";

export type SidebarSectionId = "context" | "model" | "server" | "gpu" | "system";

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
  /** Dedicated GPU memory per device; empty on a machine without a GPU. */
  gpu: GpuMemory[];
  system: {
    cpuPct: number;
    perCorePct: number[];
    memUsedMiB: number;
    memTotalMiB: number;
    load1: number;
  };
}

export const SIDEBAR_SECTION_ORDER: SidebarSectionId[] = ["context", "model", "server", "gpu", "system"];

const SECTION_TITLES: Record<SidebarSectionId, string> = {
  context: "Context",
  model: "Model",
  server: "Server",
  gpu: "GPU",
  system: "System",
};

const UNKNOWN = "--";
// The ScrollBox keeps a track column plus its 1-column gutter on the right
// whenever the content overflows, so rows are laid out for the narrower box and
// never clip on the first overflowing frame.
const FULL_WIDTH = SIDEBAR_WIDTH - 6;
// The label column fits the longest label ("context size"); plain rows then
// get the whole remainder so a number is never cut, and meter rows reserve
// room for the percentage and the bar instead.
const LABEL_WIDTH = 13;
const VALUE_WIDTH = FULL_WIDTH - LABEL_WIDTH;
const METER_GAP = 2;
const METER_VALUE_WIDTH = 5;
const METER_WIDTH = FULL_WIDTH - LABEL_WIDTH - METER_VALUE_WIDTH - METER_GAP;
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
  /** 0..1 fill for the gradient meter drawn after the value. */
  bar?: number;
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
  return [
    { label: "context size", value: knownTotal === undefined ? UNKNOWN : formatCount(knownTotal) },
    {
      label: "used",
      value: used === undefined ? UNKNOWN : formatCount(used),
      tone: used === undefined ? "muted" : "text",
    },
    {
      label: "",
      value: knownTotal === undefined ? UNKNOWN : pct(fraction),
      bar: fraction,
      wide: true,
    },
  ];
}

function optionalValue(value: number | null): string {
  return value === null ? "off" : String(value);
}

export function formatModelRows(model: SidebarData["model"]): SidebarRow[] {
  return [
    { label: "name", value: model.name },
    { label: "source", value: model.source },
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
  // Same gradient meter as the context block, with every core's percentage.
  const rows: SidebarRow[] = [{ label: "CPU", value: pct(system.cpuPct), bar: system.cpuPct }];
  system.perCorePct.forEach((core, index) => {
    rows.push({ label: `c${index}`, value: pct(core), bar: core, tone: "muted" });
  });
  rows.push({ label: "MEM", value: pct(memFrac), bar: memFrac });
  rows.push({ label: "used", value: `${system.memUsedMiB} / ${system.memTotalMiB} MiB` });
  rows.push({ label: "load", value: system.load1.toFixed(2) });
  return rows;
}

/**
 * VRAM per device. A machine with no GPU produces no rows at all, and a section
 * with no rows is hidden: an empty "GPU" block would be noise. Shared-memory
 * parts (Apple Silicon, integrated graphics) say so instead of inventing a
 * number they cannot report.
 */
export function formatGpuRows(gpus: GpuMemory[]): SidebarRow[] {
  const rows: SidebarRow[] = [];
  gpus.forEach((gpu, index) => {
    const label = index === 0 ? "gpu" : `gpu${index + 1}`;
    rows.push({ label, value: gpu.name });
    if (gpu.shared) {
      rows.push({ label: "vram", value: "shared", tone: "muted" });
      rows.push({ label: "total", value: `${formatGiB(gpu.totalBytes)} system`, tone: "muted" });
      return;
    }
    const used = gpu.usedBytes;
    const fraction = used !== undefined && gpu.totalBytes > 0 ? used / gpu.totalBytes : 0;
    rows.push({
      label: "vram",
      value: used === undefined ? UNKNOWN : pct(fraction),
      bar: used === undefined ? undefined : fraction,
      tone: used === undefined ? "muted" : "text",
    });
    rows.push({
      label: "used",
      // The unit is written once, the way the MEM row does it.
      value: used === undefined ? `? / ${formatGiB(gpu.totalBytes)}` : `${gibValue(used)} / ${gibValue(gpu.totalBytes)} GiB`,
    });
  });
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
  /** A section with no rows (a GPU section on a machine with no GPU) is hidden. */
  hidden: boolean;
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
      gpu: formatGpuRows(data.gpu),
      system: formatSystemRows(data.system),
    };
    for (const section of this.sections) {
      const wanted = rows[section.id];
      this.resizeRows(section, wanted.length);
      wanted.forEach((row, index) => this.paintRow(section.texts[index]!, row));
      this.setSectionHidden(section, wanted.length === 0);
    }
    this.syncCursor();
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
    const visible = this.sections.filter((section) => !section.hidden);
    if (visible.length === 0) return;
    const current = visible.findIndex((section) => section.id === this.cursorId());
    const from = current >= 0 ? current : 0;
    const next = visible[(from + delta + visible.length) % visible.length];
    if (next) this.cursor = this.sections.indexOf(next);
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
      hidden: false,
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

  private meterChunks(frac: number, width: number): TextChunk[] {
    return gradientFill(frac, width, meterTokens(this.theme));
  }

  private paintRow(text: TextRenderable, row: SidebarRow): void {
    const tone = row.tone ?? "text";
    const value = tone === "text" ? this.theme.text : tone === "accent" ? this.theme.accent : this.theme.muted;
    if (row.bar !== undefined) {
      // Wide meter rows carry their own percentage, then the bar spans the rest
      // of the panel; labelled rows keep the label/value columns.
      const chunks: TextChunk[] = [];
      if (row.wide) {
        chunks.push(fg(this.theme.muted)(truncate(row.value, 6).padEnd(6, " ")));
        chunks.push(...this.meterChunks(row.bar, FULL_WIDTH - 6));
      } else {
        const label = truncate(row.label.padEnd(LABEL_WIDTH), LABEL_WIDTH);
        chunks.push(fg(this.theme.muted)(label));
        chunks.push(fg(value)(truncate(row.value, METER_VALUE_WIDTH).padEnd(METER_VALUE_WIDTH, " ")));
        chunks.push(fg(this.theme.meterTrack)(" ".repeat(METER_GAP)));
        chunks.push(...this.meterChunks(row.bar, METER_WIDTH));
      }
      text.content = new StyledText(chunks);
      return;
    }
    if (row.wide) {
      text.content = new StyledText([fg(this.theme.muted)(truncate(row.value, FULL_WIDTH))]);
      return;
    }
    const label = truncate(row.label.padEnd(LABEL_WIDTH), LABEL_WIDTH);
    text.content = new StyledText([fg(this.theme.muted)(label), fg(value)(truncate(row.value, VALUE_WIDTH))]);
  }

  private syncSection(section: Section): void {
    section.box.visible = !section.hidden;
    section.body.visible = !section.collapsed;
    this.paintHeader(section);
  }

  private setSectionHidden(section: Section, hidden: boolean): void {
    if (section.hidden === hidden) return;
    section.hidden = hidden;
    if (hidden) this.releaseSectionFocus(section);
    this.syncSection(section);
  }

  private releaseSectionFocus(section: Section): void {
    if (section.header.focused) section.header.blur();
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
    // The cursor can land on a section that has since gone empty, e.g. a GPU
    // that went away: pull it back to the first visible section.
    if (this.sections[this.cursor]?.hidden) {
      const first = this.sections.find((section) => !section.hidden);
      if (first) this.cursor = this.sections.indexOf(first);
    }
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
