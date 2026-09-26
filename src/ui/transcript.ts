import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  type BaseRenderable,
  type CliRenderer,
} from "@opentui/core";
import { staticText, surface } from "./components.js";
import { transcriptViewportPadding } from "./layout.js";
import { activityFrame } from "./spinner.js";
import type { UiTheme } from "./theme.js";
import type { AssistantResult } from "./types.js";

const THINKING_TICK_MS = 120;
const THROTTLE_MS = 33;

export interface TranscriptOptions {
  renderer: CliRenderer;
  theme: UiTheme;
  scrollbarVisible: boolean;
  showThinking: boolean;
  /** Injected in tests; defaults to a 33ms throttle interval. */
  throttleMs?: number;
}

export interface ActiveAssistantMessage {
  /** Model thinking deltas (llama.cpp `reasoning_content`). */
  pushThinking(token: string): void;
  /** Visible answer deltas. */
  push(token: string): void;
  /** Full answer text accumulated so far (thinking excluded). */
  text(): string;
  done(detail?: AssistantResult): void;
}

// OpenCode formats sub-minute reasoning with whole milliseconds and everything
// above with one decimal, which keeps the collapsible header stable in width.
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatAssistantFooter(text: string, detail?: AssistantResult): string {
  const interrupted = detail?.interrupted === true;
  if (text.trim().length === 0) {
    // Interrupted while still thinking: the turn was cut short, not empty.
    if (interrupted) return "interrupted";
    return detail?.finishReason !== undefined ? `(no response — ${detail.finishReason})` : "(no response)";
  }
  const parts: string[] = [];
  if (detail?.tokens !== undefined && detail.tokPerSecond !== undefined) {
    parts.push(`▣ ${detail.tokens} tok · ${detail.tokPerSecond.toFixed(1)} tok/s`);
  } else if (detail?.tokens !== undefined) {
    parts.push(`▣ ${detail.tokens} tok`);
  } else if (detail?.tokPerSecond !== undefined) {
    parts.push(`▣ ${detail.tokPerSecond.toFixed(1)} tok/s`);
  }
  if (detail?.thoughtMs !== undefined && detail.thoughtMs > 0) {
    parts.push(`thought ${formatThinkingDuration(detail.thoughtMs)}`);
  }
  if (interrupted) parts.push("interrupted");
  return parts.join(" · ");
}

export function mixHex(base: string, tint: string, ratio: number): string {
  const from = parseHex(base);
  const to = parseHex(tint);
  const clamped = Math.min(1, Math.max(0, ratio));
  const channels = from.map((value, index) => Math.round(value + (to[index]! - value) * clamped));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(hex: string): [number, number, number] {
  const body = hex.trim().replace(/^#/, "");
  const full = body.length === 3 ? body.split("").map((c) => c + c).join("") : body;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

// OpenCode's anti-jitter trick: the gap above a message is resolved in a
// pre-layout pass from the previous sibling's identity, never from its live
// height, so a one-line streaming update never reflows the whole transcript.
// The gap never drops below one blank row, otherwise a one-line turn butts
// straight against the message before it; only the very first message, which
// has nothing above it to separate from, starts flush with the top edge.
const MESSAGE_GAP = 1;
const previousByParent = new WeakMap<
  BaseRenderable,
  { frameId: number; previous: WeakMap<BaseRenderable, BaseRenderable | undefined> }
>();

function previousSiblings(parent: BaseRenderable, frameId: number): WeakMap<BaseRenderable, BaseRenderable | undefined> {
  const previous = new WeakMap<BaseRenderable, BaseRenderable | undefined>();
  parent.getChildren().forEach((child, index, children) => previous.set(child, children[index - 1]));
  previousByParent.set(parent, { frameId, previous });
  return previous;
}

function setPreLayoutSiblingMargin(
  box: BoxRenderable,
  margin: (previous?: BaseRenderable) => number,
): void {
  box.onLifecyclePass = () => {
    const parent = box.parent;
    if (!parent) return;
    const cached = previousByParent.get(parent);
    const previous = cached?.frameId === box.ctx.frameId ? cached.previous : previousSiblings(parent, box.ctx.frameId);
    const value = margin(previous.get(box));
    if (box.marginTop !== value) box.marginTop = value;
  };
}

interface ThinkingBlock {
  owner: AssistantEntry;
  root: BoxRenderable;
  header: TextRenderable;
  body: MarkdownRenderable;
  expanded: boolean;
}

interface AssistantEntry {
  root: BoxRenderable;
  placeholder: TextRenderable;
  answer: MarkdownRenderable;
  footer: TextRenderable;
  thinking: ThinkingBlock | null;
  text: string;
  pendingAnswer: string;
  thinkingText: string;
  pendingThinking: string;
  /** Server-reported duration; wins over the measured span when present. */
  thoughtMs: number | undefined;
  /** First reasoning delta, if the model ever reasoned. */
  reasoningAt: number | undefined;
  /** First content delta, or the end of the turn: the thinking phase is over. */
  reasoningEndedAt: number | undefined;
  ticks: number;
  ticker: ReturnType<typeof setInterval> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
  finished: boolean;
}

export class Transcript {
  readonly body: ScrollBoxRenderable;
  // OpenCode starts the message list with a one-row spacer so a short
  // conversation never touches the top edge of the window.
  private readonly topSpacer: BoxRenderable;
  private readonly syntax: SyntaxStyle;
  private readonly entries = new Set<AssistantEntry>();
  private readonly throttleMs: number;
  private scrollbarVisible: boolean;
  private showThinking: boolean;
  private counter = 0;

  constructor(private readonly options: TranscriptOptions) {
    this.scrollbarVisible = options.scrollbarVisible;
    this.showThinking = options.showThinking;
    this.throttleMs = options.throttleMs ?? THROTTLE_MS;
    this.syntax = SyntaxStyle.create();
    this.body = new ScrollBoxRenderable(options.renderer, {
      id: "transcript",
      flexGrow: 1,
      minHeight: 0,
      // ScrollBox lays out `wrapper + scrollbar` as a row; forcing a column
      // stacks the scrollbar under the content and steals two rows.
      stickyScroll: true,
      stickyStart: "bottom",
      // One column is reserved on the right of the viewport so text never runs
      // under the bar while it is on screen.
      viewportOptions: { paddingRight: transcriptViewportPadding(this.scrollbarVisible) },
      // The options go through the constructor on purpose: the setter marks the
      // bar as manually controlled, which pins it on screen even when the
      // transcript fits. Left on auto it paints only while the content
      // overflows, and still sits on the right edge of the column.
      verticalScrollbarOptions: {
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: this.theme.panel,
          foregroundColor: this.theme.border,
        },
      },
    });
    // An explicit "no scrollbar" preference still has to win over auto-hide.
    if (!this.scrollbarVisible) this.body.verticalScrollBar.visible = false;
    // A one-row spacer plus the standard message gap means the first message
    // starts two rows below the top edge instead of touching it.
    this.topSpacer = surface(options.renderer, { id: "transcript-top", height: 1, flexShrink: 0 });
    this.body.add(this.topSpacer);
  }

  private get theme(): UiTheme {
    return this.options.theme;
  }

  private get renderer(): CliRenderer {
    return this.options.renderer;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  setScrollbarVisible(visible: boolean): void {
    this.scrollbarVisible = visible;
    if (visible) {
      // Back to auto: the bar reappears as soon as the transcript overflows.
      this.body.verticalScrollBar.resetVisibilityControl();
    } else {
      this.body.verticalScrollBar.visible = false;
    }
    this.body.viewportOptions = { paddingRight: transcriptViewportPadding(visible) };
  }

  setShowThinking(visible: boolean): void {
    this.showThinking = visible;
    for (const entry of this.entries) {
      if (entry.thinking === null && visible) this.createThinkingBlock(entry);
      const block = entry.thinking;
      if (!block) continue;
      if (entry.thinkingText.length > 0) block.body.content = entry.thinkingText;
      block.header.content = this.thinkingHeader(entry);
      this.syncThinkingVisibility(entry);
    }
  }

  isShowThinking(): boolean {
    return this.showThinking;
  }

  addUser(text: string): void {
    const box = surface(this.renderer, {
      id: this.nextId("user"),
      backgroundColor: this.theme.panel,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      marginTop: 1,
      rule: { sides: ["left"], color: this.theme.accent },
    });
    const hoverBackground = mixHex(this.theme.panel, this.theme.border, 0.22);
    box.onMouseOver = () => {
      box.backgroundColor = hoverBackground;
    };
    box.onMouseOut = () => {
      box.backgroundColor = this.theme.panel;
    };
    // `wrapMode` must be set after construction: a constructor `wrapMode` makes
    // the auto width measure as zero before Yoga ever constrains the node.
    const label = new TextRenderable(this.renderer, { content: text });
    label.wrapMode = "word";
    label.flexShrink = 1;
    label.fg = this.theme.text;
    label.selectable = true;
    box.add(label);
    this.separate(box);
    this.body.add(box);
  }

  addNotice(text: string): void {
    const box = surface(this.renderer, {
      id: this.nextId("notice"),
      paddingLeft: 1,
      marginTop: 1,
    });
    const line = staticText(this.renderer, { content: `* ${text}`, fg: this.theme.muted });
    line.wrapMode = "word";
    line.flexShrink = 1;
    box.add(line);
    this.separate(box);
    this.body.add(box);
  }

  beginAssistant(): ActiveAssistantMessage {
    // OpenCode renders assistant turns as plain text indented from the gutter:
    // no rule, no bubble. Only the user's own message gets a panel and a rule.
    // The 3-column indent lines assistant text up with the text inside the
    // user's bordered bubble (1 rule column + 2 padding columns).
    const root = surface(this.renderer, {
      id: this.nextId("assistant"),
      paddingLeft: 3,
      paddingRight: 2,
      marginTop: 1,
    });
    root.flexDirection = "column";
    const placeholder = staticText(this.renderer, {
      id: `${root.id}-pending`,
      content: `${activityFrame(0)} thinking`,
      fg: this.theme.muted,
    });
    const answer = new MarkdownRenderable(this.renderer, {
      id: `${root.id}-answer`,
      content: "",
      syntaxStyle: this.syntax,
      streaming: true,
      conceal: true,
      internalBlockMode: "top-level",
      fg: this.theme.text,
      bg: this.theme.background,
    });
    answer.selectable = true;
    answer.visible = false;
    answer.marginTop = 1;
    const footer = staticText(this.renderer, {
      id: `${root.id}-footer`,
      content: "",
      fg: this.theme.muted,
    });
    footer.marginTop = 1;
    footer.visible = false;
    root.add(placeholder);
    root.add(answer);
    root.add(footer);
    const entry: AssistantEntry = {
      root,
      placeholder,
      answer,
      footer,
      thinking: null,
      text: "",
      pendingAnswer: "",
      thinkingText: "",
      pendingThinking: "",
      thoughtMs: undefined,
      reasoningAt: undefined,
      reasoningEndedAt: undefined,
      ticks: 0,
      ticker: null,
      flushTimer: null,
      lastFlush: 0,
      finished: false,
    };
    if (this.showThinking) this.createThinkingBlock(entry);
    this.separate(root);
    this.body.add(root);
    this.entries.add(entry);
    this.startTicker(entry);
    return {
      pushThinking: (token: string) => this.pushThinking(entry, token),
      push: (token: string) => this.push(entry, token),
      text: () => `${entry.text}${entry.pendingAnswer}`,
      done: (detail?: AssistantResult) => this.done(entry, detail),
    };
  }

  isEmpty(): boolean {
    return this.body.getChildren().every((child) => child === this.topSpacer);
  }

  viewportHeight(): number {
    const height = this.body.viewport.height;
    return Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;
  }

  scrollByRows(rows: number): void {
    this.body.scrollBy(rows);
  }

  scrollToTop(): void {
    this.body.scrollTo(0);
  }

  scrollToBottom(): void {
    this.body.scrollTo(this.body.scrollHeight);
  }

  destroy(): void {
    for (const entry of this.entries) {
      this.clearTicker(entry);
      this.clearFlush(entry);
    }
    this.entries.clear();
    this.body.destroy();
    this.syntax.destroy();
  }

  private separate(box: BoxRenderable): void {
    setPreLayoutSiblingMargin(box, (previous) => (previous === undefined ? 0 : MESSAGE_GAP));
  }

  private createThinkingBlock(entry: AssistantEntry): ThinkingBlock {
    const block: ThinkingBlock = {
      owner: entry,
      root: undefined as unknown as BoxRenderable,
      header: undefined as unknown as TextRenderable,
      body: undefined as unknown as MarkdownRenderable,
      expanded: true,
    };
    // A plain muted line above the answer, sharing the answer's column. The
    // previous version nested its own left rule inside the message rule, which
    // drew a stray bar beside the header and the footer.
    const root = surface(this.renderer, {
      id: `${entry.root.id}-thought`,
      marginTop: 0,
    });
    root.flexDirection = "column";
    const header = staticText(this.renderer, {
      id: `${entry.root.id}-thought-label`,
      content: "▸ thinking…",
      fg: this.theme.muted,
    });
    const body = new MarkdownRenderable(this.renderer, {
      id: `${entry.root.id}-thought-body`,
      content: "",
      syntaxStyle: this.syntax,
      streaming: true,
      conceal: true,
      internalBlockMode: "top-level",
      fg: this.theme.muted,
      bg: this.theme.background,
    });
    body.selectable = true;
    body.marginTop = 0;
    body.visible = false;
    header.onMouseUp = () => this.toggleThinking(block);
    root.add(header);
    root.add(body);
    block.root = root;
    block.header = header;
    block.body = body;
    entry.thinking = block;
    entry.root.insertBefore(root, entry.answer);
    this.syncThinkingVisibility(entry);
    return block;
  }

  // A thought block only exists once the model actually reasoned: an empty
  // header row would otherwise trail every answer. While the reasoning is
  // still streaming the header states that fact without claiming a duration.
  private syncThinkingVisibility(entry: AssistantEntry): void {
    const block = entry.thinking;
    if (!block) return;
    const hasText = entry.thinkingText.length > 0;
    block.root.visible = this.showThinking && hasText;
    block.body.visible = block.expanded && hasText;
  }

  private toggleThinking(block: ThinkingBlock): void {
    block.expanded = !block.expanded;
    block.header.content = this.thinkingHeader(block.owner);
    this.syncThinkingVisibility(block.owner);
  }

  // The Braille placeholder and the thought block would otherwise both claim
  // the screen: the placeholder steps aside at the first delta of either kind.
  private syncPlaceholder(entry: AssistantEntry): void {
    const started =
      entry.reasoningAt !== undefined || entry.text.length > 0 || entry.pendingAnswer.length > 0;
    if (!started) return;
    this.clearTicker(entry);
    entry.placeholder.visible = false;
  }

  private pushThinking(entry: AssistantEntry, token: string): void {
    if (entry.finished || token.length === 0) return;
    if (entry.reasoningAt === undefined) entry.reasoningAt = Date.now();
    this.syncPlaceholder(entry);
    entry.pendingThinking += token;
    this.queueFlush(entry);
  }

  private push(entry: AssistantEntry, token: string): void {
    if (entry.finished || token.length === 0) return;
    this.endThinking(entry);
    entry.pendingAnswer += token;
    this.syncPlaceholder(entry);
    this.queueFlush(entry);
  }

  private queueFlush(entry: AssistantEntry): void {
    if (entry.flushTimer !== null) return;
    const elapsed = Date.now() - entry.lastFlush;
    if (elapsed >= this.throttleMs) {
      this.flush(entry);
      return;
    }
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      this.flush(entry);
    }, this.throttleMs - elapsed);
  }

  private clearFlush(entry: AssistantEntry): void {
    if (entry.flushTimer === null) return;
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }

  // Markdown re-parses on every content change, so answer and reasoning are
  // only handed to their renderable on a ~30fps cadence.
  private flush(entry: AssistantEntry): void {
    entry.lastFlush = Date.now();
    if (entry.pendingThinking.length > 0) {
      entry.thinkingText += entry.pendingThinking;
      entry.pendingThinking = "";
      const block = entry.thinking;
      if (block) block.body.content = entry.thinkingText;
    }
    if (entry.pendingAnswer.length > 0) {
      entry.text += entry.pendingAnswer;
      entry.pendingAnswer = "";
      entry.answer.content = entry.text;
      entry.answer.visible = true;
      entry.answer.streaming = true;
    }
    this.syncPlaceholder(entry);
    if (entry.thinking) entry.thinking.header.content = this.thinkingHeader(entry);
    this.syncThinkingVisibility(entry);
  }

  // The first content delta ends the thinking phase and freezes its duration.
  // An interrupted turn has no such delta, so the end of the turn closes it.
  private endThinking(entry: AssistantEntry): void {
    if (entry.reasoningAt === undefined || entry.reasoningEndedAt !== undefined) return;
    entry.reasoningEndedAt = Date.now();
  }

  private thinkingHeader(entry: AssistantEntry): string {
    const duration = this.thoughtDuration(entry);
    if (duration === undefined) return "▸ thinking…";
    const marker = entry.thinking?.expanded === true ? "▾" : "▸";
    return duration > 0 ? `${marker} Thought for ${formatThinkingDuration(duration)}` : `${marker} Thought`;
  }

  // Undefined while the model is still reasoning, so the header cannot claim a
  // duration it has not measured yet. The server's own number wins when it
  // reports one, otherwise the span from first reasoning to first content.
  private thoughtDuration(entry: AssistantEntry): number | undefined {
    if (entry.reasoningAt === undefined || entry.reasoningEndedAt === undefined) return undefined;
    return entry.thoughtMs ?? entry.reasoningEndedAt - entry.reasoningAt;
  }

  private startTicker(entry: AssistantEntry): void {
    if (entry.ticker !== null) return;
    entry.ticker = setInterval(() => {
      this.syncPlaceholder(entry);
      if (!entry.placeholder.visible) return;
      entry.ticks += 1;
      entry.placeholder.content = `${activityFrame(entry.ticks)} thinking`;
    }, THINKING_TICK_MS);
  }

  private clearTicker(entry: AssistantEntry): void {
    if (entry.ticker === null) return;
    clearInterval(entry.ticker);
    entry.ticker = null;
  }

  private done(entry: AssistantEntry, detail?: AssistantResult): void {
    if (entry.finished) return;
    this.clearTicker(entry);
    this.clearFlush(entry);
    entry.finished = true;
    this.endThinking(entry);
    entry.thoughtMs = detail?.thoughtMs;
    this.flush(entry);
    entry.answer.streaming = false;
    if (entry.text.length === 0) {
      entry.placeholder.visible = false;
      entry.answer.visible = false;
    }
    const footer = formatAssistantFooter(entry.text, detail);
    entry.footer.content = footer;
    entry.footer.visible = footer.length > 0;
    if (entry.thinking) {
      entry.thinking.body.streaming = false;
      entry.thinking.header.content = this.thinkingHeader(entry);
    }
  }
}
