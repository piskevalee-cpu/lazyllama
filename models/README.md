# models/

Drop GGUF model files here — LazyLlama auto-discovers them, no server setup needed.

- Put one or more `*.gguf` files in this directory.
- `bun run dev` lists discovered models for selection; it does not start a model automatically.
- Alternatively, pass `--model <file>` to open directly on the configuration editor.
- Anything else works too: `--model /path/to/model.gguf` or `--model hf:user/repo` (downloads on first run).

Model files (`*.gguf`, `*.bin`, `*.safetensors`) are git-ignored; this README is committed.
