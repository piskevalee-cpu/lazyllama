# OpenTUI configuration surveyed from OpenCode

This survey records the OpenTUI runtime patterns found in the local OpenCode
checkout and exactly how LazyLlama replicates the compatible subset.

OpenCode source: `opencode/`, TUI package version `1.18.32`.
OpenCode OpenTUI versions: Core/Keymap/Solid `0.4.5`.
LazyLlama OpenTUI version: Core `0.5.12`; LazyLlama remains imperative Core and
does not adopt OpenCode’s Solid framework.

## Renderer host configuration

OpenCode creates its renderer in `opencode/packages/tui/src/app.tsx` with:

- `externalOutputMode: "passthrough"`
- `targetFps: 60`
- `gatherStats: false`
- `exitOnCtrlC: false`
- `useKittyKeyboard: {}`
- `autoFocus: false`
- `openConsoleOnError: false`
- Conditional mouse support from host configuration
- Console copy-selection binding for Ctrl+Y

LazyLlama replicates the applicable host settings in
`src/ui/opentui.ts:12` through shared `RENDERER_CONFIG`:

- Same output mode, frame rate, stats, Ctrl+C, Kitty keyboard, autofocus, and
  error-console behavior.
- Mouse remains unconditionally disabled because LazyLlama is keyboard-first.
- `@opentui/core` is now pinned to `0.5.12` instead of `latest`.

## Lifecycle and terminal title

OpenCode owns renderer acquisition/release with Effect finalizers, handles
`SIGHUP`, resolves shutdown through the renderer `destroy` event, and always
clears the terminal title in `opencode/packages/tui/src/util/renderer.ts:1`.

LazyLlama replicates the teardown contract in `src/ui/opentui.ts:32`:

- Set the terminal title to `"LazyLlama"` during production startup.
- Always reset the title to `""` before checking destruction state.
- Destroy the renderer exactly once.
- Keep LazyLlama’s existing idempotent Ctrl+C/SIGINT/SIGTERM shutdown path for
  stopping the managed `llama-server` before renderer teardown.

## Theme and terminal mode

OpenCode’s theme system spans:

- `opencode/packages/tui/src/theme/assets/opencode.json:1`
- `opencode/packages/tui/src/theme/index.ts:36`
- `opencode/packages/tui/src/context/theme.tsx:82`

Important behaviors:

- Theme JSON uses reusable `defs` plus explicit `dark` and `light` variants.
- Terminal palette detection can generate a `system` theme.
- Theme mode may be locked, persisted, refreshed over `SIGUSR2`, or derived from
  terminal capabilities.
- The resolved background is applied with `renderer.setBackgroundColor`.
- Syntax highlighting has separate normal and subtle generated styles.

LazyLlama replicates a deliberately smaller theme contract in
`src/ui/theme.ts:1`:

- Dark and light neutrals/status colors follow OpenCode’s bundled values.
- Selection and focus keep LazyLlama’s green accent for product identity.
- Production startup waits up to one second for `renderer.waitForThemeMode`,
  then falls back to dark, mirroring OpenCode’s non-blocking startup behavior.
- The resolved background is applied to the production renderer.

LazyLlama does not replicate custom theme discovery, persistent theme settings,
`SIGUSR2` refresh, syntax-style generation, or the full 90-field theme schema.

## Keyboard aliases and bindings

OpenCode normalizes aliases in `opencode/packages/tui/src/keymap.tsx:112`:

- `enter` → `return`
- `esc` → `escape`
- `pgdown` → `pagedown`
- `pgup` → `pageup`

Relevant OpenCode bindings include:

- Application exit: `ctrl+c,ctrl+d,<leader>q`
- Message paging: `pageup`, `pagedown`, and `ctrl+alt` line/half-page variants
- Diff item toggle: `enter,space`
- Focus switching: `tab` and `shift+tab`

LazyLlama replicates the alias map in `src/ui/keys.ts:15` and applies it to
application-level key handling. LazyLlama already used canonical `return`,
`escape`, `pageup`, `pagedown`, `home`, and `end`; aliases now work as well.
Editor focus still moves with Tab/Shift+Tab, and action buttons still respond
to Enter/Space.

Session keys live in one registry, `src/ui/bindings.ts:1`, with the same ids and
defaults as OpenCode's session command list:

- `session.scroll.page.up/down`: `pageup`/`pagedown` plus `ctrl+alt+b`/`ctrl+alt+f`
- `session.scroll.half.page.up/down`: `ctrl+alt+u`/`ctrl+alt+d`
- `session.scroll.line.up/down`: `ctrl+alt+y`/`ctrl+alt+e`
- `session.scroll.top/bottom`: `ctrl+g`/`home` and `ctrl+alt+g`/`end`
- `session.sidebar.toggle`: `ctrl+b` (OpenCode uses `<leader>b`)
- `session.interrupt`: `escape`, two-step
- `prompt.submit`: `return`; newlines are shift/ctrl/alt+`return` and `ctrl+j`

`src/ui/keys.ts:1` implements the OpenCode-style spec matcher (`ctrl+alt+b`),
the `global`/`editor`/`unfocused` scopes that keep `home`/`end` inside the
editor, and the `base`/`modal` mode stack, so footer hints are generated from
the registry instead of hand-written strings. LazyLlama does not adopt
`@opentui/keymap`, leader sequences, command-palette dispatch, or configurable
keybind files.

## Animation and spinner

OpenCode’s spinner in `opencode/packages/tui/src/component/spinner.tsx:1` uses:

```text
⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
```

- 80ms native spinner interval
- Theme-derived muted color
- `animations_enabled` setting with a static `⋯` fallback

LazyLlama replicates the Braille frame sequence in `src/ui/spinner.ts:4` for
assistant thinking output. It does not add the `opentui-spinner` package, the
native Solid spinner component, or a persisted animations setting. The custom
splash glint remains LazyLlama-specific.

## Overlays, focus, and selection

Useful OpenCode patterns reviewed but not fully replicated:

- Modal dialogs use an absolute overlay at `zIndex={3000}`, backdrop dismissal,
  Escape/Ctrl+C handling, and restoration of the previously focused renderable.
- Toasts appear as an absolute bordered panel with info/success/warning/error
  variants and timed dismissal.
- Selection-aware dismissal avoids closing dialogs while copying text.
- Copy-on-select and clipboard integration are host-configurable.

The chat side panel and the config overlay now use these patterns: the panel
overlay is an absolute box with a translucent scrim and backdrop dismissal, the
config overlay is a centered modal with a scrim, both hide the prompt focus
while open, and selection-aware dismissal keeps a copy drag from toggling
anything. Copy-on-select is implemented: any mouse selection is copied with
`copyToClipboardOSC52` on release and then cleared, `ctrl+c` copies instead of
quitting while a selection exists, and `ctrl+y` is bound to the built-in
`copy-selection` console action.

## Header, footer, and model placement

OpenCode’s session view has no header bar at all: metadata lives in the side
panel and context usage appears both in the panel and as a compact readout
under the prompt. LazyLlama now matches that:

- `shell.chrome` keeps one title/hints row, but only for the splash, model
  picker and config editor; the chat view hides it.
- `src/ui/sidebar.ts:1` is the 42-column panel: a flex column above 120
  columns, an absolute overlay with a scrim below it, toggled with `ctrl+b` and
  persisted in `configDir()/ui-flags.json`. It is a chat-only surface:
  `ChatScreen.hide()` deactivates it, so the splash, model picker and config
  editor get the full terminal width.
- Panel sections are Context (`context size`, `used`, gradient meter), Model,
  Server and System, each folding with `▸`/`▾`; the old fixed perf column and
  the footer context bar are gone. Model has no `ctx` row because Context owns
  the window size, and System reuses the same meter with a percentage for every
  core. Sampling values the user switched off show as `off`.
- The context meter is live: `readSlotContext()` reads `/slots` (prompt tokens
  plus generated) once a second, so `used` climbs while the model generates and
  the exact `timings` total replaces it when the turn completes.
- The prompt footer row shows the busy spinner or model hint on the left and
  `esc interrupt` (or `esc again to interrupt` once armed) plus the compact
  `12.3K (45%)` context readout on the right.
- The pre-chat screens have no header row either. `shell.footer` is the only
  chrome: the key reference on the left, `<model> · <source> · <status>` on the
  right, and `hintsFor()` picks the longest reference that fits so the two slots
  never overlap. Exactly one editor row carries the `▸` marker at a time.
- Local models display as extensionless basenames; Hugging Face models display
  as repos; absolute home paths abbreviate to `~` only in details.

## Testing patterns

OpenCode tests renderer teardown with a fake renderer in
`opencode/packages/tui/test/util/renderer.test.ts:1` and tests theme resolution
and custom-theme precedence without a live terminal.

LazyLlama replicates those patterns in `test/opentui-config.test.ts:1`:

- Shared renderer configuration is asserted exactly.
- Terminal-title teardown is tested for live and already-destroyed renderers.
- Theme tokens and dark-mode fallback are tested.
- Key aliases and spinner frames are tested.
- Interactive behavior continues to use `@opentui/core/testing` with real
  renderer input and mandatory renderer destruction.

Chat history handling follows the same snapshot discipline: `submitChatMessage`
copies completed history before the assistant placeholder is appended, and the
SSE parser reads both streaming deltas and final message content. Empty model
responses surface the server `finish_reason` instead of a bare placeholder.

Chat and editor surfaces follow OpenCode’s frameless language: panel
backgrounds with single left/bottom accent rules, bold titles with muted
secondary copy, `▸` selection markers, and one vertical column so plain
arrow-down walks every field and action end to end.

## Theme

`src/ui/meter.ts` owns the shared gradient fill: `gradientFill` for meters and
`sweepFill` for the splash's indeterminate loading bar, so the splash and the
side panel are literally the same bar.

`src/ui/theme.ts` is deliberately monochrome rather than a port: black and
white over a grey ramp (`#000000` → `#0a0a0a` → `#141414` → `#262626` →
`#8c8c8c`), so the palette came off OpenCode entirely. Two extra tokens drive
the meters: `meter` is a three-step white-to-grey ramp and `meterTrack` the dim
track. A `SidebarRow` with a `bar` paints its fill as three `StyledText` chunks
that fade through the ramp, which is where the "gradient" reads on screen.

## Message list, scrolling, and mouse

- The chat column keeps a one-row gap above the prompt dock, so the last
  message never touches the prompt box.
- `src/ui/transcript.ts:1` is a sticky-bottom `ScrollBoxRenderable`
  (`stickyScroll`, `stickyStart: "bottom"`) with a themed scrollbar. Returning
  to the bottom re-engages stickiness, so there is no "jump to latest" button.
- Assistant answers render through OpenTUI’s `MarkdownRenderable` with
  `streaming: true`, so code blocks and lists match the reference. Content is
  handed to the parser on a ~30fps throttle and flushed on completion. Markdown
  finalization is asynchronous, so a test must sleep briefly before asserting
  on rendered markdown.
- Message chrome follows the reference exactly: the user message is a panel
  bubble with an accent left rule, while assistant turns are plain text
  indented to the same column, with the reasoning block as a muted
  `▾ Thought for {duration}` line directly above the answer. A nested rule
  inside a message is the mistake that produced a stray bar next to the header
  and footer.
- Keyboard scrolling uses the same commands and the same counter-intuitive
  sizes: a "page" is half the viewport, a "half page" a quarter
  (`src/ui/layout.ts:1`).
- Every scroller (hub editor, transcript, side panel) passes its
  `verticalScrollbarOptions` in the `ScrollBoxRenderable` constructor, so the
  bar sits on the right edge of the column and auto-hides whenever the content
  fits. Assigning the options through the property setter would set the bar's
  manual-visibility flag and pin it permanently. Setting
  `flexDirection: "column"` on a ScrollBox stacks the bar *under* the content
  instead of beside it — the bug that clipped the editor fields and left a
  floating track mid-screen.
- Mouse reporting is on by default. Wheel scrolling, edge auto-scroll during a
  drag, and scrollbar dragging come from `ScrollBoxRenderable`; LazyLlama adds
  click-to-focus on the prompt and hover states on messages and panel headers.
  `--no-mouse` or `LAZYLLAMA_NO_MOUSE=1` restores the terminal’s own selection.

## Interrupt and thinking

There is no `/stop` endpoint in the current llama.cpp server. Stopping
generation means closing the request: the two-step `esc` aborts the in-flight
`fetch`, llama-server notices the disconnect (`req.should_stop` in
`server-context.cpp`), cancels the task and frees the slot, and the next request
reuses the cached prefix. Partial text is kept and the footer gains a muted
`interrupted` marker.

Model thinking is opt-in per request with `reasoning_format` (`auto` splits
thinking into `reasoning_content` deltas, `none` keeps it inline; llama.cpp’s
default is `none`). LazyLlama sends `auto`, streams those deltas into a
collapsible `▾ Thought for {duration}` block above the answer, reports the
duration in the answer footer as `thought {duration}`, and `ctrl+t` toggles all
thinking blocks. Verified against a real server: a reasoning model streams
`reasoning_content`, and the measured thought time is request start to first
content token.

## Files changed for this replication

- `package.json`
- `AGENTS.md`
- `src/config.ts`
- `src/logo.ts`
- `src/server.ts`
- `src/index.ts`
- `src/shutdown.ts`
- `src/ui/opentui.ts`
- `src/ui/theme.ts`
- `src/ui/spinner.ts`
- `src/ui/keys.ts`
- `src/ui/app.ts`
- `src/ui/controller.ts`
- `src/ui/hubView.ts`
- `src/ui/splashView.ts`
- `src/ui/chatView.ts`
- `src/ui/shell.ts`
- `src/ui/layout.ts`
- `src/ui/bindings.ts`
- `src/ui/flags.ts`
- `src/ui/prompt.ts`
- `src/ui/sidebar.ts`
- `src/ui/transcript.ts`
- `src/splash.ts`
- `test/core.test.ts`
- `test/installer.test.ts`
- `test/opentui-config.test.ts`
- `test/layout.test.ts`
- `test/keys.test.ts`
- `test/shutdown.test.ts`
- `test/ui.test.ts`
- `docs/opentui-from-opencode.md`
