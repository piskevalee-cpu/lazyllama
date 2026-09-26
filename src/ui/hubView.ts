import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import {
  CONFIG_FIELDS,
  CONFIG_GROUP_ORDER,
  CONFIG_GROUP_TITLES,
  fieldDisplay,
  modelDisplayName,
  type ConfigFieldDef,
  type ConfigFieldGroup,
  type LaunchConfig,
} from "../config.js";
import {
  entryLabel,
  selectableEntries,
  type ModelEntry,
  type SelectableModelEntry,
} from "../hub.js";
import { lineInput, staticText, surface } from "./components.js";
import { isEnterKey } from "./keys.js";
import { DARK_THEME, type UiTheme } from "./theme.js";

export type InlineEditor = { type: "hf" } | { type: "field"; field: ConfigFieldDef };

export interface HubViewEvents {
  onActivateModel(entry: SelectableModelEntry): void;
  onActivateField(def: ConfigFieldDef): void;
  onCommitInlineEdit(value: string): void;
  onBack(): void;
  onSavePreset(): void;
  onConfirm(): void;
}

interface EditorGroup {
  id: ConfigFieldGroup;
  box: BoxRenderable;
  title: TextRenderable;
  select: SelectRenderable;
  fields: ConfigFieldDef[];
}

export type EditorDensity = "comfortable" | "compact";

// Row budget for the editor body: title + action row + status + one row per
// group title + one row per field. Comfortable adds breathing room (group
// padding and gaps); compact drops padding and gaps but keeps titles, so all
// fields still fit short terminals. Below compact, the ScrollBox takes over.
export function requiredEditorRows(
  fieldCount: number,
  groupCount: number,
  density: EditorDensity,
): number {
  const chrome = 3; // title, action row, status line
  if (density === "compact") return chrome + groupCount + fieldCount;
  return chrome + groupCount + fieldCount + groupCount * 2 + Math.max(0, groupCount - 1);
}

export function selectEditorDensity(
  availableRows: number,
  fieldCount: number,
  groupCount: number,
): EditorDensity {
  return availableRows >= requiredEditorRows(fieldCount, groupCount, "comfortable")
    ? "comfortable"
    : "compact";
}

interface HubAction {
  id: "back" | "save" | "confirm";
  box: BoxRenderable;
  label: TextRenderable;
}

const SELECTED_MARKER = "▸";

export class HubView {
  readonly body: BoxRenderable;
  private readonly title: TextRenderable;
  private readonly modelPanel: BoxRenderable;
  private readonly emptyNotice: TextRenderable;
  private readonly modelSelect: SelectRenderable;
  private readonly editorGroupsWrap: BoxRenderable;
  private readonly editorGroups: ScrollBoxRenderable;
  private readonly groups: EditorGroup[];
  private readonly editRow: BoxRenderable;
  private readonly editLabel: TextRenderable;
  private readonly editInput: InputRenderable;
  private readonly actionRow: BoxRenderable;
  private readonly actions: HubAction[];
  private readonly status: TextRenderable;
  private selectableRows: SelectableModelEntry[] = [];
  private modelBaseNames: string[] = [];
  private editorConfig: LaunchConfig | null = null;
  private editor: InlineEditor | null = null;
  private editorReturnFocus: SelectRenderable | null = null;
  private readonly optionActivations = new Map<string, (index: number) => void>();
  // Remembered so a refresh (after an inline edit, when focus sits on the text
  // input) still marks the group the user was working in.
  private activeGroup: EditorGroup | null = null;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly events: HubViewEvents,
    private readonly theme: UiTheme = DARK_THEME,
  ) {
    this.body = new BoxRenderable(renderer, {
      id: "hub",
      flexDirection: "column",
      flexGrow: 1,
      visible: false,
      paddingLeft: 2,
      paddingRight: 2,
    });
    this.title = staticText(renderer, { id: "hub-title", fg: theme.text, bold: true });

    this.modelPanel = surface(renderer, {
      id: "hub-models-panel",
      backgroundColor: theme.panel,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      flexGrow: 1,
      rule: { sides: ["left"], color: theme.borderActive },
    });
    const modelTitle = staticText(renderer, {
      id: "hub-models-title",
      content: "Models",
      fg: theme.accent,
      bold: true,
    });
    this.emptyNotice = staticText(renderer, { id: "hub-empty", fg: theme.muted });
    this.modelSelect = this.createSelect(renderer, "hub-models");
    this.modelSelect.on(SelectRenderableEvents.ITEM_SELECTED, (index) => {
      const entry = this.selectableRows[index];
      if (entry) this.events.onActivateModel(entry);
    });
    this.optionActivations.set(this.modelSelect.id, (index) => {
      const entry = this.selectableRows[index];
      if (entry) this.events.onActivateModel(entry);
    });
    this.modelSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
      this.setMarkedOptions(this.modelSelect, this.modelBaseNames);
    });
    this.modelPanel.add(modelTitle);
    this.modelPanel.add(this.emptyNotice);
    this.modelPanel.add(this.modelSelect);

    // One vertical column: arrow-down travels through every group, then the
    // action buttons, top to bottom. The column scrolls on short terminals and
    // the ScrollBox lives inside a plain flex wrapper: a flex-grown ScrollBox
    // with automatic height corrupts its preceding siblings' Yoga positions.
    const editorGroupsWrap = new BoxRenderable(renderer, {
      id: "hub-groups-wrap",
      flexDirection: "column",
      flexGrow: 1,
      minHeight: 0,
      visible: false,
    });
    // The ScrollBox root must stay a row: it holds the viewport plus the
    // vertical scrollbar side by side. Forcing a column stacks the bar under
    // the content, which both truncates the fields and leaves the bar floating
    // in the middle of the screen, so group spacing goes on `contentOptions`.
    // The scrollbar options go through the constructor on purpose: that path
    // leaves the bar's manual-visibility flag unset, so it auto-hides whenever
    // the groups already fit.
    this.editorGroups = new ScrollBoxRenderable(renderer, {
      id: "hub-groups",
      flexGrow: 1,
      minHeight: 0,
      width: "100%",
      contentOptions: { flexDirection: "column", gap: 1 },
      viewportOptions: { paddingRight: 1 },
      verticalScrollbarOptions: {
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: theme.panel,
          foregroundColor: theme.borderActive,
        },
      },
    });
    this.editorGroups.focusable = false;
    editorGroupsWrap.add(this.editorGroups);
    this.editorGroupsWrap = editorGroupsWrap;
    this.groups = CONFIG_GROUP_ORDER.map((id) => this.createEditorGroup(renderer, id));
    for (const group of this.groups) this.editorGroups.add(group.box);

    this.editRow = new BoxRenderable(renderer, {
      id: "hub-edit",
      flexDirection: "row",
      visible: false,
    });
    this.editLabel = staticText(renderer, { id: "hub-edit-label", fg: theme.muted });
    this.editInput = lineInput(renderer, { id: "hub-edit-input" });
    this.editInput.backgroundColor = theme.panel;
    this.editInput.focusedBackgroundColor = theme.panel;
    this.editInput.textColor = theme.text;
    this.editInput.focusedTextColor = theme.text;
    this.editInput.placeholderColor = theme.muted;
    this.editInput.cursorColor = theme.text;
    this.editInput.on(InputRenderableEvents.ENTER, () => {
      this.events.onCommitInlineEdit(this.editInput.value);
    });
    this.editRow.add(this.editLabel);
    this.editRow.add(this.editInput);

    this.actionRow = new BoxRenderable(renderer, {
      id: "hub-actions",
      flexDirection: "row",
      gap: 2,
      visible: false,
    });
    const back = this.createAction(renderer, "hub-back", "back", "Back", () => this.events.onBack());
    const save = this.createAction(renderer, "hub-save", "save", "Save preset", () =>
      this.events.onSavePreset(),
    );
    const confirm = this.createAction(renderer, "hub-confirm", "confirm", "Confirm & start", () =>
      this.events.onConfirm(),
    );
    this.actions = [back, save, confirm];
    for (const action of this.actions) this.actionRow.add(action.box);
    this.status = staticText(renderer, { id: "hub-status", fg: theme.muted });

    this.body.add(this.title);
    this.body.add(this.modelPanel);
    this.body.add(this.actionRow);
    this.body.add(this.editorGroupsWrap);
    this.body.add(this.editRow);
    this.body.add(this.status);
  }

  isEditing(): boolean {
    return this.editor !== null;
  }

  editorCounts(): { fields: number; groups: number } {
    return {
      fields: this.groups.reduce((total, group) => total + group.fields.length, 0),
      groups: this.groups.length,
    };
  }

  moveModelSelection(direction: 1 | -1): void {
    if (direction === 1) this.modelSelect.moveDown();
    else this.modelSelect.moveUp();
  }

  selectedField(): ConfigFieldDef | null {
    const focused = this.renderer.currentFocusedRenderable;
    for (const group of this.groups) {
      if (group.select === focused) {
        return group.fields[group.select.getSelectedIndex()] ?? null;
      }
    }
    return null;
  }

  setVisible(visible: boolean): void {
    this.body.visible = visible;
    if (!visible) this.blurEditorControls();
  }

  setStatus(text: string): void {
    this.status.content = text;
  }

  showModels(entries: ModelEntry[], selected = 0): void {
    this.title.content = "Select a model";
    const hasEmptyNotice = entries.some((entry) => entry.kind === "empty");
    this.emptyNotice.content = hasEmptyNotice ? entryLabel({ kind: "empty" }) : "";
    this.emptyNotice.visible = hasEmptyNotice;
    this.selectableRows = selectableEntries(entries);
    this.modelBaseNames = this.selectableRows.map((entry) => entryLabel(entry));
    this.modelSelect.options = this.markedOptions(
      this.modelBaseNames,
      Math.min(selected, Math.max(0, this.selectableRows.length - 1)),
    );
    this.modelSelect.setSelectedIndex(
      Math.min(selected, Math.max(0, this.selectableRows.length - 1)),
    );
    this.setMarkedOptions(this.modelSelect, this.modelBaseNames);
    this.editorGroupsWrap.visible = false;
    this.actionRow.visible = false;
    this.modelPanel.visible = true;
    this.blurEditorControls();
    this.modelSelect.focus();
  }

  refreshModels(entries: ModelEntry[]): void {
    const selected = this.modelSelect.getSelectedIndex();
    const hasEmptyNotice = entries.some((entry) => entry.kind === "empty");
    this.emptyNotice.content = hasEmptyNotice ? entryLabel({ kind: "empty" }) : "";
    this.emptyNotice.visible = hasEmptyNotice;
    this.selectableRows = selectableEntries(entries);
    this.modelBaseNames = this.selectableRows.map((entry) => entryLabel(entry));
    this.modelSelect.options = this.markedOptions(
      this.modelBaseNames,
      Math.min(selected, Math.max(0, this.selectableRows.length - 1)),
    );
    this.modelSelect.setSelectedIndex(
      Math.min(selected, Math.max(0, this.selectableRows.length - 1)),
    );
    this.setMarkedOptions(this.modelSelect, this.modelBaseNames);
    this.editorGroupsWrap.visible = false;
    this.actionRow.visible = false;
    this.modelPanel.visible = true;
    this.blurEditorControls();
    this.modelSelect.focus();
  }

  showEditor(cfg: LaunchConfig, selectedGlobal = 0): void {
    this.editorConfig = cfg;
    this.editorReturnFocus = null;
    this.title.content = `Configure — ${modelDisplayName(cfg.model)}`;
    this.emptyNotice.visible = false;
    const target = this.locateGlobalField(selectedGlobal);
    target.group.select.setSelectedIndex(target.local);
    this.markGroups(target.group);
    this.modelPanel.visible = false;
    this.editorGroupsWrap.visible = true;
    this.actionRow.visible = this.editor === null;
    this.modelSelect.blur();
    target.group.select.focus();
    this.editorGroups.scrollChildIntoView(target.group.box.id);
  }

  refreshEditor(cfg: LaunchConfig): void {
    this.editorConfig = cfg;
    this.title.content = `Configure — ${modelDisplayName(cfg.model)}`;
    this.markGroups(
      this.groups.find((group) => group.select === this.focusedEditorGroup()) ?? this.activeGroup ?? undefined,
    );
    this.actionRow.visible = this.editor === null;
    const returnFocus = this.editorReturnFocus;
    this.editorReturnFocus = null;
    if (returnFocus && this.groups.some((group) => group.select === returnFocus)) {
      returnFocus.focus();
      const group = this.groups.find((item) => item.select === returnFocus);
      if (group) this.editorGroups.scrollChildIntoView(group.box.id);
    } else if (!this.focusedEditorStop()) {
      this.groups[0]?.select.focus();
    }
  }

  focusNextEditorControl(): void {
    this.focusEditorControl(1);
  }

  focusPreviousEditorControl(): void {
    this.focusEditorControl(-1);
  }

  // Compact density drops group padding and gaps so every field and action
  // fits short terminals; the ScrollBox remains as a last resort.
  setDensity(density: EditorDensity): void {
    for (const group of this.groups) {
      group.box.paddingTop = density === "comfortable" ? 1 : 0;
      group.box.paddingBottom = density === "comfortable" ? 1 : 0;
    }
    this.editorGroups.contentOptions = {
      flexDirection: "column",
      gap: density === "comfortable" ? 1 : 0,
    };
  }

  // Lateral movement between Back/Save/Confirm when an action has focus.
  focusAdjacentAction(direction: 1 | -1): boolean {
    const focused = this.renderer.currentFocusedRenderable;
    const index = this.actions.findIndex((action) => action.box === focused);
    if (index === -1) return false;
    const next = this.actions[(index + direction + this.actions.length) % this.actions.length];
    next?.box.focus();
    return true;
  }

  // Continuous vertical traversal: plain arrow-down walks every field in every
  // group, then the action buttons. Returns true when the key was consumed.
  moveEditorSelection(direction: 1 | -1): boolean {
    const stops = this.editorStops();
    if (stops.length === 0) return false;
    const current = this.focusedEditorStop();
    let index = -1;
    if (current?.kind === "field") {
      index = stops.findIndex(
        (stop) =>
          stop.kind === "field" && stop.group === current.group && stop.local === current.local,
      );
    } else if (current?.kind === "action") {
      index = stops.findIndex(
        (stop) => stop.kind === "action" && stop.action === current.action,
      );
    }
    if (index === -1) {
      this.focusStop(
        direction === 1 ? (stops[0] ?? null) : (stops[stops.length - 1] ?? null),
      );
      return true;
    }
    const next = stops[(index + direction + stops.length) % stops.length];
    if (!next) return false;
    this.focusStop(next);
    return true;
  }

  beginHfEdit(): void {
    this.editorReturnFocus = this.focusedEditorGroup();
    this.editor = { type: "hf" };
    this.editLabel.content = "HF repo (user/model[:quant]): ";
    this.editInput.value = "";
    this.editRow.visible = true;
    this.actionRow.visible = false;
    this.editInput.focus();
  }

  beginFieldEdit(def: ConfigFieldDef, initialValue: string): void {
    this.editorReturnFocus = this.focusedEditorGroup();
    this.editor = { type: "field", field: def };
    this.editLabel.content = `${def.label}${def.hint ? ` (${def.hint})` : ""}: `;
    this.editInput.value = initialValue;
    this.editRow.visible = true;
    this.actionRow.visible = false;
    this.editInput.focus();
  }

  finishInlineEdit(): InlineEditor | null {
    const editor = this.editor;
    this.editor = null;
    this.editRow.visible = false;
    this.editInput.blur();
    return editor;
  }

  private createSelect(renderer: CliRenderer, id: string): SelectRenderable {
    const select = new SelectRenderable(renderer, {
      id,
      flexGrow: 1,
      backgroundColor: this.theme.panel,
      textColor: this.theme.text,
      focusedBackgroundColor: this.theme.panel,
      focusedTextColor: this.theme.text,
      showDescription: false,
      showSelectionIndicator: false,
      showScrollIndicator: true,
      selectedTextColor: this.theme.accent,
      selectedBackgroundColor: this.theme.panel,
      wrapSelection: true,
      keyBindings: [
        { name: "enter", action: "select-current" },
        { name: "kpenter", action: "select-current" },
      ],
    });
    // SelectRenderable has no built-in mouse handling, so a click focuses it
    // and a click on a row activates that row, the way OpenCode's lists work.
    select.onMouseDown = (event) => {
      event.stopPropagation();
      select.focus();
    };
    select.onMouseUp = (event) => {
      event.stopPropagation();
      if (this.renderer.getSelection()?.getSelectedText()) return;
      const option = this.optionAtRow(select, event.y);
      if (option === undefined) return;
      select.setSelectedIndex(option);
      this.activateOption(select, option);
    };
    return select;
  }

  // Options render one per row (descriptions are off), so a click maps to an
  // index by offset from the select's top edge.
  private optionAtRow(select: SelectRenderable, y: number): number | undefined {
    const top = select.y;
    if (!Number.isFinite(top) || y < top) return undefined;
    const row = Math.floor(y - top);
    const count = select.options.length;
    if (row < 0 || row >= count) return undefined;
    return row;
  }

  private activateOption(select: SelectRenderable, index: number): void {
    const activate = this.optionActivations.get(select.id);
    activate?.(index);
  }

  private createEditorGroup(renderer: CliRenderer, id: (typeof CONFIG_GROUP_ORDER)[number]): EditorGroup {
    const fields = CONFIG_FIELDS.filter((def) => def.group === id);
    const box = surface(renderer, {
      id: `hub-group-${id}`,
      backgroundColor: this.theme.panel,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      flexGrow: 0,
      flexShrink: 0,
      width: "100%",
      rule: { sides: ["left"], color: this.theme.border },
    });
    const title = staticText(renderer, {
      id: `hub-group-${id}-title`,
      content: CONFIG_GROUP_TITLES[id],
      fg: this.theme.accent,
      bold: true,
    });
    const select = this.createSelect(renderer, `hub-group-${id}-select`);
    select.on(SelectRenderableEvents.ITEM_SELECTED, (index) => {
      const def = fields[index];
      if (def) this.events.onActivateField(def);
    });
    this.optionActivations.set(select.id, (index) => {
      const def = fields[index];
      if (def) this.events.onActivateField(def);
    });
    select.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
      if (this.editorConfig) {
        this.setMarkedOptions(select, this.editorBaseNames({ fields }, this.editorConfig));
      }
    });
    box.add(title);
    box.add(select);
    return { id, box, title, select, fields };
  }

  private createAction(
    renderer: CliRenderer,
    id: string,
    actionId: HubAction["id"],
    label: string,
    onActivate: () => void,
  ): HubAction {
    // OpenCode-style action: no frame, primary background only while focused.
    const box = new BoxRenderable(renderer, {
      id,
      border: false,
      paddingLeft: 2,
      paddingRight: 2,
      focusable: true,
    });
    const text = staticText(renderer, { content: label, fg: this.theme.muted });
    box.add(text);
    box.onKeyDown = (key: KeyEvent) => {
      if (isEnterKey(key) || key.name === "space") {
        onActivate();
        key.stopPropagation();
      }
    };
    box.on(RenderableEvents.FOCUSED, () => {
      if (box.isDestroyed || text.isDestroyed) return;
      box.backgroundColor = this.theme.primary;
      text.fg = this.theme.background;
      text.attributes = 1;
    });
    box.on(RenderableEvents.BLURRED, () => {
      if (box.isDestroyed || text.isDestroyed) return;
      box.backgroundColor = "transparent";
      text.fg = this.theme.muted;
      text.attributes = 0;
    });
    return { id: actionId, box, label: text };
  }

  private editorBaseNames(group: Pick<EditorGroup, "fields">, cfg: LaunchConfig): string[] {
    return group.fields.map((def) => `${def.label}: ${fieldDisplay(cfg, def)}`);
  }

  private markedOptions(
    baseNames: string[],
    selected: number,
  ): Array<{ name: string; description: string; value: number }> {
    return baseNames.map((name, index) => ({
      name: `${index === selected ? SELECTED_MARKER : " "} ${name}`,
      description: "",
      value: index,
    }));
  }

  private setMarkedOptions(select: SelectRenderable, baseNames: string[]): void {
    const selected = select.getSelectedIndex();
    select.options = this.markedOptions(baseNames, selected);
    select.height = Math.max(1, baseNames.length);
  }

  // Re-mark every group so exactly one row carries the marker: the active
  // group keeps its local selection, the others fall back to the first row.
  private markGroups(active?: EditorGroup): void {
    if (active !== undefined) this.activeGroup = active ?? null;
    for (const group of this.groups) {
      const names = this.editorConfig ? this.editorBaseNames(group, this.editorConfig) : [];
      // -1 marks no row, so exactly one row in the whole editor is marked.
      const mark = group === active ? group.select.getSelectedIndex() : -1;
      group.select.options = this.markedOptions(names, mark);
      if (group === active) group.select.setSelectedIndex(mark);
      group.select.height = Math.max(1, names.length);
    }
  }

  private locateGlobalField(selectedGlobal: number): { group: EditorGroup; local: number } {
    let remaining = Math.max(0, selectedGlobal);
    for (const group of this.groups) {
      if (remaining < group.fields.length) return { group, local: remaining };
      remaining -= group.fields.length;
    }
    const last = this.groups[this.groups.length - 1] ?? this.groups[0];
    if (!last) throw new Error("config editor has no field groups");
    return { group: last, local: Math.max(0, last.fields.length - 1) };
  }

  private focusedEditorGroup(): SelectRenderable | null {
    const focused = this.renderer.currentFocusedRenderable;
    for (const group of this.groups) {
      if (group.select === focused) return group.select;
    }
    return null;
  }

  private focusedEditorStop(): { kind: "field"; group: EditorGroup; local: number } | { kind: "action"; action: HubAction } | null {
    const focused = this.renderer.currentFocusedRenderable;
    for (const group of this.groups) {
      if (group.select === focused) {
        return { kind: "field", group, local: group.select.getSelectedIndex() };
      }
    }
    for (const action of this.actions) {
      if (action.box === focused) return { kind: "action", action };
    }
    return null;
  }

  private editorStops(): Array<
    | { kind: "field"; group: EditorGroup; local: number; control: SelectRenderable }
    | { kind: "action"; action: HubAction; control: BoxRenderable }
  > {
    const stops: Array<
      | { kind: "field"; group: EditorGroup; local: number; control: SelectRenderable }
      | { kind: "action"; action: HubAction; control: BoxRenderable }
    > = [];
    for (const group of this.groups) {
      group.fields.forEach((_, local) => {
        stops.push({ kind: "field", group, local, control: group.select });
      });
    }
    for (const action of this.actions) {
      stops.push({ kind: "action", action, control: action.box });
    }
    return stops;
  }

  private focusStop(
    stop:
      | { kind: "field"; group: EditorGroup; local: number; control: SelectRenderable }
      | { kind: "action"; action: HubAction; control: BoxRenderable }
      | null
      | undefined,
  ): void {
    if (!stop) return;
    if (stop.kind === "field") {
      stop.group.select.setSelectedIndex(stop.local);
      this.markGroups(stop.group);
      stop.control.focus();
      this.editorGroups.scrollChildIntoView(stop.group.box.id);
      return;
    }
    stop.control.focus();
    this.editorGroups.scrollChildIntoView(stop.control.id);
  }

  private editorFocusOrder(): Renderable[] {
    return [
      ...this.groups.map((group) => group.select),
      ...this.actions.map((action) => action.box),
    ];
  }

  private focusEditorControl(direction: 1 | -1): void {
    const order = this.editorFocusOrder();
    if (order.length === 0) return;
    const current = this.renderer.currentFocusedRenderable;
    const index = order.findIndex((control) => control === current);
    const next = order[(index + direction + order.length) % order.length];
    next?.focus();
  }

  private blurEditorControls(): void {
    this.modelSelect.blur();
    this.editInput.blur();
    for (const group of this.groups) group.select.blur();
    for (const action of this.actions) action.box.blur();
  }
}
