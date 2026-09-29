<!-- Best README Template (https://github.com/othneildrew/Best-README-Template) -->
<a id="readme-top"></a>

<div align="center">

[![CI][ci-shield]][ci-url]
[![Bun][bun-shield]][bun-url]
[![TypeScript][ts-shield]][ts-url]
[![OpenTUI][tui-shield]][tui-url]
[![License][license-shield]][license-url]
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]

# LazyLlama

**A keyboard-first terminal client for a model you run yourself.**

One managed `llama-server`, one prompt, no cloud. Pick a model, tune the launch
flags, chat — and let the wizard provision the server and put `lazyllama` on your
`PATH`.

`bun run setup` → a server that matches your hardware, a models directory, and
a `lazyllama` command that works from anywhere.

[Report Bug][bug-url] &middot; [Request Feature][feature-url] &middot; [MIT licensed][license-url]

</div>

<br>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#a-session">A session</a></li>
    <li><a href="#why">Why LazyLlama</a></li>
    <li><a href="#features">Features</a></li>
    <li><a href="#supported-backends">Supported backends</a></li>
    <li>
      <a href="#getting-started">Getting started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#install">Install</a></li>
        <li><a href="#models">Models</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#the-installer">The installer</a></li>
        <li><a href="#the-config-editor">The config editor</a></li>
        <li><a href="#the-manual">The manual</a></li>
        <li><a href="#keybinds">Keybinds</a></li>
        <li><a href="#in-chat">In chat</a></li>
        <li><a href="#the-side-panel">The side panel</a></li>
        <li><a href="#thinking">Thinking</a></li>
        <li><a href="#mouse">Mouse</a></li>
      </ul>
    </li>
    <li><a href="#configuration">Configuration</a></li>
    <li><a href="#dependencies">Dependencies</a></li>
    <li><a href="#project-structure">Project structure</a></li>
    <li><a href="#development">Development</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<br>

<!-- SESSION -->
## A session

```text
  ▸ LazyLlama                                                      vulkan · 18.4 tok/s

  ┃  what is a KV cache in llama.cpp?

  ┃  ▾ Thought for 8.6s
  ┃  The user is asking about the implementation, so I should be concrete
  ┃  about the slot cache rather than the general transformer idea.

  ┃  In llama.cpp the KV cache belongs to a slot, not to the model. When a
  slot's prompt prefix is unchanged, the next request reuses those keys and
  values instead of recomputing them — which is why `cache_prompt` and
  `id_slot: 0` matter so much for a local server.

  ┃  ▣ 214 tok · 17.8 tok/s · thought 8.6s

  ▸ LazyLlama                                                        1/6 ready

  ┃
  █ loading lazyllama
```

## Why LazyLlama

Local models deserve a real interface, not an API client pointed at localhost.

* **The launch flags are the interface.** Context size, GPU layers, batching,
  sampling: a local model is configured by its flags, so they belong in a real
  editor — with the option to switch a parameter *off* instead of sending a
  default you did not choose.
* **The telemetry belongs next to the conversation.** Context usage, tokens per
  second, thought time and slot state are read live from the server's own
  `/slots` and `/props` endpoints, not from a log file.
* **One process, properly owned.** The app resolves or provisions exactly one
  `llama-server`, verifies the build can see its device, reuses the conversation
  KV cache across turns, and stops the child on Ctrl+C, SIGINT, SIGTERM or
  SIGHUP.
* **Keyboard first, mouse welcome.** Every action has a key. Scrolling, folding,
  focus and copy-on-selection all work with a mouse too.

## Features

* Setup wizard (`bun run setup`): hardware survey, backend recommendation, models directory,
  streaming download with progress, `PATH` setup — in the app's own visual
  language.
* Every llama.cpp prebuilt slice, with the requirement of each one stated and
  the ones your machine cannot run greyed out with the reason.
* OpenCode-shaped session view: sticky transcript, L-shaped prompt, collapsible
  side panel, and no chrome competing with the conversation.
* Nothing on the command line you did not choose: the editor starts every
  parameter at llama.cpp's own default and shows what that default is, and
  stepping past a maximum drops the flag from the server argv *and* the chat
  request.
* An in-app manual (`?` or `F1`): every llama.cpp parameter, its documented
  default, and what moving it actually changes — with the command your config
  produces at the top.
* Two-step Esc that really stops generation by closing the request, so
  `llama-server` cancels the task and frees the slot.
* Model thinking shown as a collapsible thought block, split out of the answer by
  llama.cpp's `reasoning_format`, with both thinking layers — `reasoning_effort`
  and `reasoning_format` — configurable.
* Live context meter that moves while the model is still generating.
* Per-model presets, a system section with a meter per CPU core, and a
  `models/` directory you can point anywhere.

## Supported backends

The wizard proposes one of these and falls back down the column until a build
downloads *and* passes verification with its device visible.

| Backend | Hardware | Platforms | Download | Requires |
| --- | --- | --- | ---: | --- |
| **CUDA 13.4** | NVIDIA | linux x64, arm64 | ~590 MiB | driver ≥ 580 |
| **CUDA 12.8** | NVIDIA | linux x64, arm64 | ~567 MiB | driver ≥ 565 |
| **ROCm 10.0** | AMD, best on RDNA 3+ | linux x64 | ~229 MiB | — |
| **Vulkan** | AMD, Intel, NVIDIA | linux x64, arm64 | ~30 MiB | Vulkan loader |
| **SYCL fp16 / fp32** | Intel oneAPI, Arc, Core Ultra | linux x64 | ~53 MiB | — |
| **OpenVINO** | Intel NPU and iGPU | linux x64 | ~40 MiB | — |
| **Metal** | Apple Silicon | macOS x64, arm64 | ~11 MiB | — |
| **CPU** | anything | linux, macOS, windows | ~17 MiB | — |
| **Build from source** | anything with cmake | linux, macOS, windows | — | cmake, make |

Windows has no prebuilt path yet: use WSL, or `--backend cpu` with a binary from
the llama.cpp releases.

## Getting started

### Prerequisites

* [Bun][bun-url] **1.4.2** — pinned in `.mise.toml`.
* A model. Drop a `.gguf` into a directory, or use a Hugging Face repo id.
* Nothing else. The `bun run setup` wizard fetches a prebuilt `llama-server` for your hardware and
  falls back to compiling llama.cpp only if every download fails.

### Install

```sh
git clone https://github.com/piskevalee-cpu/lazyllama.git
cd lazyllama
bun install
bun run setup
```

> The setup command is `setup`, not `install`: a script called `install` is a
> package manager lifecycle hook, so a plain `bun install` would run the wizard
> and start provisioning.

The wizard walks five steps: **hardware → backend → models directory →
install → `PATH`**. It ends with `lazyllama` on your `PATH`, working from any
directory, with the app copied out of the clone so the repository can be moved or
deleted afterwards.

Already have a `llama-server`? Skip the download:

```sh
LAZYLLAMA_SERVER_BIN=/path/to/llama-server bun run dev
```

Prefer to drive it yourself? The wizard is optional:

```sh
bun run setup --yes                       # every default, no prompts
bun run setup --backend vulkan            # pick a backend up front
bun run setup --models-dir ~/llama-models # where the .gguf files live
bun run setup --link                      # launcher points at this checkout
bun run setup --no-path                   # install everything, leave PATH alone
bun run setup --no-build                  # never fall back to compiling
bun run setup --tag b11200                # pin a llama.cpp release
bun run setup --help                      # every flag
```

### Models

Models are discovered from the first of these that exists:

1. `LAZYLLAMA_MODELS_DIR`
2. the directory the wizard chose, `~/lazyllama-models` by default
3. `./models`, so a fresh clone works with nothing configured

```sh
lazyllama                                     # pick from the discovered models
lazyllama --model ~/llama-models/qwen3.gguf   # open the editor directly
bun run dev --model hf:unsloth/Qwen3-8B-GGUF # download from Hugging Face on first run
```

Per-model presets are remembered in `~/.config/lazyllama/presets.json`, so
switching models restores the flags you used last.

## Usage

### The installer

| Key | Action |
| --- | --- |
| `↑` `↓` | move through the backends, or the `PATH` answer |
| `Enter` | confirm the current row |
| `r` | rescan the hardware (survey step) |
| `Esc` | back a step; cancel the download while installing |
| `Ctrl+C` | quit |

The `PATH` step is the only one that touches a file outside the XDG directories.
It shows the exact line it would append, in your shell's own syntax, and needs
an explicit `Enter` — never a silent edit of your dotfile.

### The config editor

| Key | Action |
| --- | --- |
| `↑` `↓` | walk every field, then the action buttons |
| `←` `→` | adjust the focused value, move between Back / Save / Confirm, or move the model selection |
| `Tab` `Shift+Tab` | jump between groups and actions |
| `Enter` | edit the focused field inline |
| `s` | save the preset for this model |
| `?`, `Ctrl+K` | the manual, the keybinds |
| `Esc` | back to the model list |

| Group | Fields |
| --- | --- |
| Context | context size, rope scale, keep tokens |
| Launch | GPU layers, threads, batch threads, batch size, micro batch, jinja templates |
| Sampling | temperature, top-p, top-k, repeat penalty, thinking effort, reasoning format |
| Network | host, port, `--props`, `--metrics` |
| Advanced | raw extra arguments |

**Only the context group ships a value.** Everything else starts at llama.cpp's
own default, and a row that reads `default (x)` is not on the command line at
all: llama.cpp applies `x` instead. Nothing is sent that you did not choose, so
the default run is `-m <model> -c 0` and nothing else — and `-c 0` is llama.cpp's
own "use the model's context".

| Row | `default (…)` means | Sent as |
| --- | --- | --- |
| `gpu layers (-ngl)` | `auto` | `-ngl auto`, `0` or `all` |
| `threads (-t)`, `batch threads (-tb)` | hardware concurrency | `-t` / `-tb` |
| `batch size (-b)` | `2048` | `-b` |
| `micro batch (-ub)` | `512` | `-ub` |
| `jinja templates (--jinja)` | `on` | `--jinja` or `--no-jinja` |
| `temperature`, `top-p`, `top-k`, `repeat penalty` | `0.8`, `0.95`, `40`, `1.0` | the flag, plus the same value in the chat request |
| `thinking effort` | auto, detected from the template | `reasoning_effort` |
| `reasoning format` | `auto` | `reasoning_format` |
| `props endpoint (--props)` | `off`, `GET /props` is read-only anyway | `--props` |
| `metrics endpoint (--metrics)` | `off` | `--metrics` |

Every parameter is droppable again by walking its value range: step past the
maximum and the flag leaves the command. Booleans have three states — not sent,
`--flag`, `--no-flag` — so an explicit "no" stays reachable. Typing `default`,
`auto`, `none`, `off` or an empty value in the inline editor also drops it.
Per-model presets are saved to `~/.config/lazyllama/presets.json`.

`GET /props` needs no flag, which is why the props row can stay on its default
and the live context meter still works.

### The manual

Press `?` or `F1` on any screen and scroll with `↑` `↓`, `PgUp` `PgDn`, `Home`
and `End`. `Ctrl+K` opens the keybinds next to it, and the same key again closes
whichever help screen is open. `Esc` returns to exactly the screen and row you
left, including from the middle of the config editor.

The manual documents every parameter LazyLlama can affect, in seven groups:
context, GPU and memory, threads and batching, sampling, thinking, templates,
and the server endpoints. Each entry states three things: the flag as it appears
on the command line, **llama.cpp's own documented default**, and what moving it
actually changes — for example that `--cache-type-v q8_0` roughly halves the KV
memory, or that `--samplers` applies temperature last, so it has the last word.

The header shows the command your current config produces and a one-line summary
of everything you have moved off its default, so the manual always describes the
run in front of you. Parameters the editor does not expose (`--flash-attn`,
`--cache-type-k`, `--load-mode`, `--numa`, `-sm`, `--swa-full`, `--context-shift`,
`--mirostat`, `--min-p`, `--parallel`, `-cb`, `--api-key`, `--timeout`, …) are
documented there too, and reach the server through **extra args**.

### Keybinds

`Ctrl+K` opens the keybinds next to the manual, from any screen. Every command
the app owns is listed, grouped by where it applies — everywhere, in chat, the
model picker and config editor, the launch config overlay, and the help screens
themselves — with the key it is bound to right now.

| Key | Action |
| --- | --- |
| `↑` `↓` | move through the list |
| `Enter` | start recording: the next key press becomes the binding |
| `Del` | restore the command's default |
| `Esc` | back |

Overrides are saved to `~/.config/lazyllama/keybinds.json` and are keyed by
command, so a rebound key changes what the key *does* everywhere at once: the
footer reference, the editor, the config overlay and the help screens all read
the same registry. A key bound to two commands is reported rather than silently
shadowing one of them. Two entries are listed as **fixed** — activating the
focused row and the prompt's newline keys — because OpenTUI resolves those
inside the widget that draws them.

`Esc` and `Enter` cannot be rebound to nothing: there is no key to press to
clear a binding, and `Del` is the way back to the default.

### Thinking

Thinking is two independent layers, and both are configurable:

| Parameter | What it decides | Default |
| --- | --- | --- |
| `thinking effort` (`reasoning_effort`) | whether the model reasons and how hard — `none` disables it, the levels are handed to the chat template | not sent, so llama.cpp detects the model's own behaviour |
| `reasoning format` (`reasoning_format`) | how the reasoning text comes back | `auto` |

`reasoning_format` matters for this client in particular, because the collapsible
thought block is built from `reasoning_content` deltas:

| Value | Result |
| --- | --- |
| `auto`, `deepseek` | thoughts in `reasoning_content`, streaming deltas included — the Thought block works |
| `none` | nothing is extracted; thinking stays inline in the answer text |
| `deepseek-legacy` | `<think>` tags stay visible in the answer while streaming, so the Thought block stays empty and the tags land in the reply |

Leaving both at their default is the sensible choice: the model thinks if it
wants to, and the thinking arrives in a block you can fold. While the model
reasons, that block shows a spinner and no duration; the first content token
freezes it as `Thought for 8.6s`. `Ctrl+T` hides all of it, and the setting
persists.

The server-level counterparts (`--reasoning on|off|auto`, `--reasoning-budget`,
`--reasoning-preserve`) and `chat_template_kwargs` such as
`{"enable_thinking": false}` are documented in the manual and reachable through
extra args.

### In chat

| Key | Action |
| --- | --- |
| `Enter` | send |
| `Shift+Enter`, `Ctrl+Enter`, `Alt+Enter`, `Ctrl+J` | newline |
| `Esc`, `Esc` | arm, then interrupt generation (5s window) |
| `PgUp` `PgDn` | scroll half a viewport |
| `Ctrl+Alt+U` `Ctrl+Alt+D` | scroll a quarter |
| `Ctrl+Alt+Y` `Ctrl+Alt+E` | scroll one line |
| `Ctrl+G` / `Home`, `Ctrl+Alt+G` / `End` | jump to the top or the bottom |
| `Ctrl+B` | toggle the side panel |
| `Alt+B`, `Alt+↑` `Alt+↓`, `Alt+Enter` | walk and fold the panel sections |
| `Ctrl+R` | toggle the transcript scrollbar |
| `Ctrl+T` | show or hide model thinking |
| `F2` | the launch config overlay |
| `Ctrl+X` | back to the model picker, keeping the server and the conversation |
| `?`, `F1` | the parameter manual |
| `Ctrl+K` | the keybinds |
| `Ctrl+Y` | copy the selection |
| `Ctrl+C` | copy the selection, otherwise quit |

The first `Esc` arms the interrupt and the second aborts the in-flight request.
Closing the request is how generation stops: `llama-server` cancels the task and
frees the slot. There is no stop endpoint to call. A partial answer keeps its
text and gets a muted `· interrupted` suffix.

### The side panel

42 columns wide, a flex column above 120 columns and an overlay below it, toggled
with `Ctrl+B`. It belongs to the chat only — the picker and the editor own the
full width.

* **Context** — window size, tokens used, and a gradient meter. The used count
  comes from `/slots` and moves while the model is still generating. It is the
  whole slot: cached prefix, prompt and answer together, which is why it is
  larger than the `tok generated` count in an answer's footer — that one is only
  what the answer itself produced.
* **Model** — name, source, GPU layers, sampling, thinking mode. No context row
  here; that belongs to Context.
* **Server** — URL, slot, context limit, tokens per second.
* **GPU** — one block per device: name, a VRAM meter and used/total. Hidden
  entirely on a machine without a GPU. Read from `nvidia-smi`, the DRM sysfs
  counters that AMD and Intel publish, or `rocm-smi`; Apple Silicon and
  integrated graphics say `shared` instead of claiming a pool they do not have.
* **System** — CPU with a meter, a meter for every core, memory and load.

### Mouse

Enabled by default, because OpenCode is: wheel scrolling, click to focus, click a
panel header to fold it, click a model row to open it, and copy-on-release with
`Ctrl+Y`. Turn it off with `--no-mouse` or `LAZYLLAMA_NO_MOUSE=1` if you prefer
your terminal's own text selection.

## Configuration

| Variable | Effect |
| --- | --- |
| `LAZYLLAMA_SERVER_BIN` | absolute path to a `llama-server`; skips the installer receipt |
| `LAZYLLAMA_MODELS_DIR` | directory scanned for `.gguf` files; wins over settings |
| `LAZYLLAMA_CONFIG_DIR` | where `settings.json`, `presets.json` and `ui-flags.json` live |
| `LAZYLLAMA_NO_MOUSE` | `1` disables mouse reporting |
| `XDG_DATA_HOME` | where the server and the app copy are installed |
| `XDG_BIN_HOME` | where the `lazyllama` launcher is written |

```jsonc
// ~/.config/lazyllama/settings.json, written by the installer
{
  "modelsDir": "/home/you/lazyllama-models",
  "backend": "vulkan",
  "launcher": "/home/you/.local/bin/lazyllama",
  "installedAt": "2026-01-01T00:00:00.000Z"
}
```

## Dependencies

| | |
| --- | --- |
| [Bun][bun-url] 1.4.2 | runtime, test runner, package manager |
| [OpenTUI Core][tui-url] 0.5.12 | renderables, layout, input, the test renderer |
| [llama.cpp][llama-url] | `llama-server` and the model runtime (provisioned, not vendored) |
| TypeScript 5.6 | the whole project, no build step for running it |

Runtime dependency closure of the installed copy: `@opentui/core` plus
`bun-ffi-structs`, `diff`, `marked`, `string-width`, `strip-ansi`,
`web-tree-sitter`, `ansi-regex`, `emoji-regex`, `get-east-asian-width` and the
prebuilt native binary for your platform. The installer copies that closure
verbatim, so the launcher gets the same build you are running and needs no
network.

## Project structure

```text
src/
  index.ts            entry: CLI parsing, boot flow, server lifecycle, chat
  install.ts          the `bun run setup` wizard and its plain-text path
  installer.ts        provisioning: release fetch, streaming download, verify
  backends.ts         the backend catalog, hardware survey, asset picking
  paths.ts            XDG roots, the launcher shim, PATH, dependency closure
  settings.ts         settings.json and the models directory
  config.ts           launch config, per-model presets, CONFIG_FIELDS
  manual.ts           the parameter manual: defaults, effects, what each one is
  models.ts           .gguf discovery
  server.ts           one llama-server: spawn, readiness, REST and SSE
  perf.ts             /slots and /props readers for the live meters
  vram.ts             dedicated GPU memory, per vendor
  shutdown.ts         one idempotent stop for Ctrl+C, SIGINT, SIGTERM, SIGHUP
  splash.ts logo.ts   the wordmark and its reveal, pure and width-aware
  ui/
    controller.ts     session state machine, keymap owner, perf polling
    chatView.ts       the chat column: transcript, prompt, side panel
    hubView.ts        model picker and the data-driven config editor
    manualView.ts     the `?` screen that renders src/manual.ts
    keybinds.ts       the command registry, overrides and key formatting
    keybindsView.ts   the Ctrl+K screen, and the footer hints that follow it
    installView.ts    the wizard's screens
    transcript.ts prompt.ts sidebar.ts splashView.ts
    theme.ts meter.ts spinner.ts keys.ts bindings.ts layout.ts
test/                 12 suites, no network and no TTY required
docs/                 the OpenTUI parity notes
```

## Development

```sh
bun install
bun run dev            # run the app against models/
bun run typecheck
bun run build
bun test ./test/*.test.ts
```

Tests never touch the network, a GPU or a real TTY: the installer suites run
from fixtures, and the UI suites drive `@opentui/core/testing` with a temp
`LAZYLLAMA_CONFIG_DIR` each. Keep tests inside `./test/*.test.ts`, because a
broader filter also discovers nested dependency tests.

UI work follows [docs/opentui-from-opencode.md](docs/opentui-from-opencode.md),
which records the OpenTUI traps this project has already hit.

## Roadmap

- [x] Managed `llama-server` with a hardware-aware setup wizard
- [x] Every llama.cpp prebuilt backend, with device verification and fallbacks
- [x] OpenCode-style session view, prompt and side panel
- [x] Launch parameters that are only sent when chosen
- [x] In-app parameter manual, and configurable thinking effort
- [x] Keybinds screen: rebind any command, and leave the chat for the menu
- [x] Two-step Esc that interrupts generation
- [x] Live context meter and model thinking
- [ ] Persist and resume conversations
- [ ] Download models from Hugging Face inside the app
- [ ] Windows support (`bun run setup --backend cpu` with a manual binary today)
- [ ] `/stats`: tokens per second and context history for a session

## Contributing

1. Fork the repository
2. Create a branch: `git checkout -b feature/something`
3. Keep `bun run typecheck` and `bun test ./test/*.test.ts` green
4. Open a pull request describing the behaviour you changed

UI work lands on `beta` before it reaches `main`.

## License

[MIT](LICENSE) © 2026 piskevalee-cpu

## Acknowledgments

* [OpenCode][opencode-url] — the TUI this client is modelled on, and the
  reference for its layout, keymap and Escape handling.
* [llama.cpp][llama-url] — the server, the sampler, and every number on screen.
* [OpenTUI][tui-url] — the renderer underneath.
* [Best README Template][readme-template] — the structure of this file.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- MARKDOWN LINKS & IMAGES -->
[ci-shield]: https://github.com/piskevalee-cpu/lazyllama/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/piskevalee-cpu/lazyllama/actions/workflows/ci.yml
[bun-shield]: https://img.shields.io/badge/bun-1.4.2-000000?style=flat-square&logo=bun&logoColor=white
[ts-shield]: https://img.shields.io/badge/TypeScript-5.6-000000?style=flat-square&logo=typescript&logoColor=white
[tui-shield]: https://img.shields.io/badge/OpenTUI-0.5.12-000000?style=flat-square&logo=terminal&logoColor=white
[license-shield]: https://img.shields.io/github/license/piskevalee-cpu/lazyllama?style=flat-square&label=MIT&color=white
[license-url]: https://github.com/piskevalee-cpu/lazyllama/blob/beta/LICENSE
[contributors-shield]: https://img.shields.io/github/contributors/piskevalee-cpu/lazyllama?style=flat-square
[contributors-url]: https://github.com/piskevalee-cpu/lazyllama/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/piskevalee-cpu/lazyllama?style=flat-square
[forks-url]: https://github.com/piskevalee-cpu/lazyllama/network/members
[stars-shield]: https://img.shields.io/github/stars/piskevalee-cpu/lazyllama?style=flat-square
[stars-url]: https://github.com/piskevalee-cpu/lazyllama/stargazers
[issues-shield]: https://img.shields.io/github/issues/piskevalee-cpu/lazyllama?style=flat-square
[issues-url]: https://github.com/piskevalee-cpu/lazyllama/issues
[bug-url]: https://github.com/piskevalee-cpu/lazyllama/issues/new?labels=bug
[feature-url]: https://github.com/piskevalee-cpu/lazyllama/issues/new?labels=enhancement
[bun-url]: https://bun.sh
[ts-url]: https://www.typescriptlang.org/
[tui-url]: https://github.com/anomalyco/opentui
[llama-url]: https://github.com/ggml-org/llama.cpp
[opencode-url]: https://github.com/sst/opencode
[readme-template]: https://github.com/othneildrew/Best-README-Template
