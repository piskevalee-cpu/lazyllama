<!-- Best README Template (https://github.com/othneildrew/Best-README-Template) -->
<a id="readme-top"></a>

<div align="center">

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![Made with Bun][bun-shield]][bun-url]
[![TUI][tui-shield]][tui-url]

```text
██╗      █████╗ ███████╗██╗   ██╗██╗     ██╗      █████╗ ███╗   ███╗ █████╗
██║     ██╔══██╗╚══███╔╝╚██╗ ██╔╝██║     ██║     ██╔══██╗████╗ ████║██╔══██╗
██║     ███████║  ███╔╝  ╚████╔╝ ██║     ██║     ███████║██╔████╔██║███████║
██║     ██╔══██║ ███╔╝    ╚██╔╝  ██║     ██║     ██╔══██║██║╚██╔╝██║██╔══██║
███████╗██║  ██║███████╗   ██║   ███████╗███████╗██║  ██║██║ ╚═╝ ██║██║  ██║
╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝
```

**LazyLlama** — a keyboard-first terminal client for a local `llama-server`.

Pick a model, tune the launch flags, chat. One managed process, one prompt,
no cloud.

[Report Bug](https://github.com/piskevalee-cpu/lazyllama/issues/new?labels=bug&template=bug-report---.md)
&middot;
[Request Feature](https://github.com/piskevalee-cpu/lazyllama/issues/new?labels=enhancement&template=feature-request---.md)

</div>

<br>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li><a href="#built-with">Built With</a></li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#models">Models</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<br>

<!-- ABOUT THE PROJECT -->
## About The Project

LazyLlama is a TUI for talking to a model you run yourself. It owns exactly one
`llama-server` child process: it resolves or downloads the binary, starts it with
the flags you chose, waits for readiness, streams `/v1/chat/completions`
responses, and shuts the process down cleanly on Ctrl+C, SIGINT, SIGTERM or
SIGHUP.

The interface is modelled on [OpenCode][opencode]: a sticky message list, an
L-shaped prompt that grows with what you type, a collapsible side panel, and no
chrome competing with the conversation.

```
┃  what is a KV cache?
┃
┃  ▾ Thought for 8.6s
┃  Because the prompt prefix is unchanged, the slot reuses its cached KV.
┃
┃  A KV cache stores the key-value pairs from previous decoding steps so the
┃  model does not have to recompute them.
┃
┃  ▣ 150 tok · 17.8 tok/s · thought 8.6s
```

Why it exists:

* Local models should feel first class, not like an API client pointed at localhost.
* Launch flags are the real interface to a local model, so they belong in a real editor.
* The useful telemetry — context window, tokens per second, thought time, slot state —
  belongs next to the conversation, not in a log file.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- BUILT WITH -->
## Built With

* [Bun][bun-url] — runtime, test runner and installer
* [TypeScript][ts-url] — the whole project
* [OpenTUI Core][opentui-url] — imperative renderables, layout and input
* [llama.cpp][llama-url] — `llama-server` and the model runtime

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* [Bun 1.4.2](https://bun.sh) (pinned in `.mise.toml`)
* A `llama-server` binary. `bun run install:server` downloads a release, or
  compiles the vendored `llama.cpp/` tree as a fallback. Never runs implicitly.
* At least one model. Drop a `.gguf` into `models/`, or pass a Hugging Face
  repo when the app starts.

### Installation

1. Clone and install
   ```sh
   git clone https://github.com/piskevalee-cpu/lazyllama.git
   cd lazyllama
   bun install
   ```
2. Provision the server binary (explicit, one time)
   ```sh
   bun run install:server
   ```
   Already have one? Point at it with `LAZYLLAMA_SERVER_BIN=/path/to/llama-server`.
3. Run it
   ```sh
   bun run dev
   ```
4. Or skip the picker
   ```sh
   bun run dev --model models/your-model.gguf --ctx 8192
   ```

### Models

Anything `llama-server` loads works. Presets are stored per model under
`~/.config/lazyllama/presets.json`, so switching models restores the flags you
used last. Set `LAZYLLAMA_CONFIG_DIR` to relocate that directory.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- USAGE -->
## Usage

The app boots splash → model picker → config editor → `Confirm & start` → chat.
`--model` skips the picker and opens the editor directly.

### In the config editor

| Key | Action |
| --- | --- |
| `↑` `↓` | walk every field, then the action buttons |
| `←` `→` | adjust the focused value, or move between Back / Save / Confirm |
| `Tab` `Shift+Tab` | jump between groups and actions |
| `Enter` | edit the focused field inline |
| `s` | save the preset for this model |
| `Esc` | back to the model list |

Sampling parameters are **toggleable**: stepping past a maximum switches the
parameter off, which omits it from both the server flags and the chat request
instead of sending a default you did not choose.

### In chat

| Key | Action |
| --- | --- |
| `Enter` | send |
| `Shift+Enter`, `Ctrl+Enter`, `Alt+Enter`, `Ctrl+J` | newline |
| `Esc` | first press arms, second press within 5s aborts generation |
| `PgUp` `PgDn` | scroll half a viewport |
| `Ctrl+Alt+U` `Ctrl+Alt+D` | scroll a quarter |
| `Ctrl+Alt+Y` `Ctrl+Alt+E` | scroll one line |
| `Ctrl+G` / `Home`, `Ctrl+Alt+G` / `End` | jump to top or bottom |
| `Ctrl+B` | toggle the side panel |
| `Ctrl+R` | toggle the transcript scrollbar |
| `Ctrl+T` | show or hide model thinking |
| `F2` | open the launch config overlay |
| `Ctrl+C` | copy a selection, otherwise quit |

### The side panel

* **Context** — window size, tokens used and a gradient meter. The used count is
  read from `/slots` while the model generates, so it moves in real time.
* **Model** — name, source, GPU layers, sampling and thinking mode.
* **Server** — URL, slot state, context limit, tok/s.
* **System** — CPU and every core with a percentage and meter, memory, load.

### Thinking

Models that emit reasoning are requested with `reasoning_format: auto`, so
llama.cpp splits thinking out of the answer. While the model reasons the thought
block shows a spinner and no duration; the first content token freezes it as
`Thought for 8.6s`. `Ctrl+T` hides all of it.

### Mouse

Enabled by default: wheel scrolling, click-to-focus, click a panel header to
fold it, click a model row to open it, and copy-on-release. Opt out with
`--no-mouse` or `LAZYLLAMA_NO_MOUSE=1`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- ROADMAP -->
## Roadmap

- [x] Managed `llama-server` lifecycle with one-command provisioning
- [x] OpenCode-style session layout: sticky transcript, L-shaped prompt, side panel
- [x] Toggleable launch parameters
- [x] Two-step Esc to interrupt generation
- [x] Real-time context meter and model thinking display
- [ ] Persist and resume conversations
- [ ] Model download from Hugging Face inside the app
- [ ] `/stats` for tok/s and context history

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- CONTRIBUTING -->
## Contributing

1. Fork the repository
2. Create a branch: `git checkout -b feature/something`
3. Keep `bun run typecheck` and `bun test ./test/*.test.ts` green
4. Open a pull request describing the behaviour you changed

The `beta` branch is where UI work lands before it reaches `main`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [OpenCode][opencode] — the TUI this client is modelled on, and a constant
  reference for layout, keymap and escape-handling behaviour.
* [llama.cpp][llama-url] — the server, the sampler and every number on screen.
* [OpenTUI][opentui-url] — the renderer underneath.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<br>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/piskevalee-cpu/lazyllama.svg?style=for-the-badge
[contributors-url]: https://github.com/piskevalee-cpu/lazyllama/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/piskevalee-cpu/lazyllama.svg?style=for-the-badge
[forks-url]: https://github.com/piskevalee-cpu/lazyllama/network/members
[stars-shield]: https://img.shields.io/github/stars/piskevalee-cpu/lazyllama.svg?style=for-the-badge
[stars-url]: https://github.com/piskevalee-cpu/lazyllama/stargazers
[issues-shield]: https://img.shields.io/github/issues/piskevalee-cpu/lazyllama.svg?style=for-the-badge
[issues-url]: https://github.com/piskevalee-cpu/lazyllama/issues
[bun-shield]: https://img.shields.io/badge/bun-1.4.2-black?style=for-the-badge&logo=bun&logoColor=white
[bun-url]: https://bun.sh
[tui-shield]: https://img.shields.io/badge/TUI-opentui-000000?style=for-the-badge&logo=terminal&logoColor=white
[tui-url]: https://opentui.com
[ts-url]: https://www.typescriptlang.org/
[opentui-url]: https://github.com/anomalyco/opentui
[llama-url]: https://github.com/ggml-org/llama.cpp
[opencode]: https://github.com/sst/opencode
