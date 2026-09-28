// The in-app manual: every llama-server parameter LazyLlama can affect, what
// it does, and how the result changes as you move it.
//
// Pure data with no TUI import, so it stays unit-testable and the screen in
// `src/ui/manualView.ts` only has to render it.
//
// Every default and every accepted value below is taken from the vendored
// llama.cpp source, not from memory:
//   tools/server/README.md   the documented flags and their defaults
//   common/arg.cpp            the argument parser and its accepted values
//   common/common.h           the struct defaults the parser starts from
// When llama.cpp changes a default, this file and the `defaultNote` on the
// matching CONFIG_FIELDS entry change together.
//
// A parameter the editor exposes carries `fieldKey`, so the screen can show
// the value in force for the current config. `manualFieldKeys()` is the
// coverage list the tests assert against CONFIG_FIELDS.

export type ManualGroupId =
  | "context"
  | "memory"
  | "batching"
  | "sampling"
  | "thinking"
  | "templates"
  | "server";

export interface ManualEntry {
  /** The flag, or the request parameter, as it appears on the command line. */
  flag: string;
  /** CONFIG_FIELDS key, when the config editor exposes this parameter. */
  fieldKey?: string;
  /** llama.cpp's own default, verbatim from its documentation. */
  llamaDefault: string;
  /** What actually changes when you raise or lower it. */
  effect: string;
}

export interface ManualGroup {
  id: ManualGroupId;
  title: string;
  blurb: string;
  entries: ManualEntry[];
}

export const MANUAL_INTRO =
  "The config editor only sends what you chose. A row reading `default (x)` means the " +
  "flag is not on the command at all and llama.cpp applies x instead. Context is the " +
  "one group that ships a value.";

export const MANUAL_GROUPS: ManualGroup[] = [
  {
    id: "context",
    title: "Context",
    blurb: "How much conversation the model can see, and what stays pinned.",
    entries: [
      {
        flag: "-c 0",
        fieldKey: "ctxSize",
        llamaDefault: "0 = loaded from model",
        effect:
          "Everything has to fit: the system prompt, the whole history and the answer. " +
          "Raising it multiplies KV memory, so it costs VRAM before it costs speed.",
      },
      {
        flag: "--rope-scale 1.0",
        fieldKey: "ropeScale",
        llamaDefault: "1.0 (flag omitted at 1)",
        effect:
          "Stretches the trained position range to reach past the model's window. Above " +
          "1 buys context at the cost of quality, and further out it falls off fast.",
      },
      {
        flag: "--keep 0",
        fieldKey: "keepTokens",
        llamaDefault: "0 = keep nothing, -1 = all",
        effect:
          "Pins the first tokens of the first prompt into every later slot. Only worth it " +
          "for a fixed system prompt you never want re-evaluated; it is spent context room " +
          "on every single turn.",
      },
      {
        flag: "--swa-full",
        llamaDefault: "false",
        effect:
          "Uses the full sliding-window cache instead of the pruned one. Helps long-context " +
          "models trained with SWA, and costs the memory the pruning saved.",
      },
      {
        flag: "--context-shift",
        llamaDefault: "disabled",
        effect:
          "Drops the oldest tokens when the window fills instead of failing. Left off, a " +
          "long conversation is refused rather than quietly losing its beginning.",
      },
    ],
  },
  {
    id: "memory",
    title: "GPU and memory",
    blurb: "What lives on the GPU, and what happens when it no longer fits.",
    entries: [
      {
        flag: "-ngl auto|all|N",
        fieldKey: "gpuLayers",
        llamaDefault: "auto",
        effect:
          "Layers held in VRAM. Tokens per second climb with it until VRAM runs out, then " +
          "the model spills to system RAM and falls off a cliff. `auto` is llama.cpp's own " +
          "default, so leaving the row alone already offloads what it can.",
      },
      {
        flag: "-kvo, --kv-offload",
        llamaDefault: "enabled",
        effect:
          "Keeps the KV cache on the GPU alongside the weights. There is no partial setting: " +
          "with it off the cache lives in RAM and generation slows sharply.",
      },
      {
        flag: "-fa, --flash-attn on|off|auto",
        llamaDefault: "auto",
        effect:
          "Flash Attention kernels: faster and lighter on the attention path. `on` is worth " +
          "trying on a model that supports it, `off` is the fallback for hardware that does " +
          "not, and `auto` lets the build decide.",
      },
      {
        flag: "-ctk, -ctv, --cache-type-k/-v TYPE",
        llamaDefault: "f16",
        effect:
          "Data type of the KV cache. q8_0 roughly halves that memory with near-identical " +
          "answers; q4_0 halves it again and starts changing the answers. This is usually " +
          "the cheapest way to fit a large context on one card.",
      },
      {
        flag: "-lm, --load-mode auto|mmap|none|mlock|mmap+mlock",
        llamaDefault: "auto (mmap)",
        effect:
          "How the weights are loaded. `mlock` keeps the model resident in RAM, so no page " +
          "out ever stalls a token; it needs the whole model free. `none` loads slower but " +
          "survives memory pressure better.",
      },
      {
        flag: "--numa distribute|isolate|numactl",
        llamaDefault: "unset",
        effect:
          "Binds execution to the NUMA nodes that own the memory. Only worth setting on a " +
          "multi-socket machine, and worth re-testing from a cold page cache.",
      },
      {
        flag: "-sm, --split-mode none|layer|row|tensor",
        llamaDefault: "layer",
        effect:
          "How a model is spread over several GPUs. `layer` is the safe default, `row` and " +
          "`tensor` parallelize the work; both are only worth it with fast interconnects.",
      },
    ],
  },
  {
    id: "batching",
    title: "Threads and batching",
    blurb: "Prefill and generation are tuned by different knobs.",
    entries: [
      {
        flag: "-t N",
        fieldKey: "threads",
        llamaDefault: "-1 = hardware concurrency",
        effect:
          "CPU threads used while generating. Speed scales close to linearly up to the core " +
          "count; past it, threads contend and the answer gets slower, not faster.",
      },
      {
        flag: "-tb N",
        fieldKey: "threadsBatch",
        llamaDefault: "same as -t",
        effect:
          "Threads used for prompt processing. Prefill is bursty, so a dedicated value can " +
          "beat -t on wide machines and hurt on small ones.",
      },
      {
        flag: "-b N",
        fieldKey: "batchSize",
        llamaDefault: "2048",
        effect:
          "Logical prompt batch. Bigger batches amortize the per-token overhead of prefill, " +
          "and raise peak memory while it runs.",
      },
      {
        flag: "-ub N",
        fieldKey: "ubatchSize",
        llamaDefault: "512",
        effect:
          "The slice actually handed to the compute device; it should divide -b. Raising it " +
          "speeds up prefill and costs VRAM.",
      },
      {
        flag: "-np, --parallel N",
        llamaDefault: "-1 = auto",
        effect:
          "Warm slots. Each one needs its own KV context, so the window per slot is the " +
          "total divided by the slot count. LazyLlama pins a single slot (id_slot 0) so the " +
          "conversation prefix stays cached between turns.",
      },
      {
        flag: "-cb, --cont-batching",
        llamaDefault: "enabled",
        effect:
          "Continuous batching: prompt and generation are processed together, which is what " +
          "keeps a shared server busy. Turn it off to measure a single request in isolation.",
      },
      {
        flag: "--cache-prompt",
        llamaDefault: "enabled",
        effect:
          "Reuses the cached prefix when the next prompt starts with the same tokens. This " +
          "is the single biggest reason the second turn of a conversation is faster than the " +
          "first.",
      },
    ],
  },
  {
    id: "sampling",
    title: "Sampling",
    blurb: "How the next token is picked. Order matters as much as the values.",
    entries: [
      {
        flag: "--temp N",
        fieldKey: "temp",
        llamaDefault: "0.8",
        effect:
          "Flattens or sharpens the distribution. Near 0 the model picks its most likely " +
          "token almost every time, which repeats itself; above ~1.2 answers drift and stop " +
          "answering the question.",
      },
      {
        flag: "--top-k N",
        fieldKey: "topK",
        llamaDefault: "40",
        effect:
          "Keeps only the k most likely tokens. Small values lock the model into its first " +
          "guess, large values let it wander into unlikely words. 0 disables it.",
      },
      {
        flag: "--top-p N",
        fieldKey: "topP",
        llamaDefault: "0.95",
        effect:
          "Keeps the smallest set of tokens whose probability sums to p. Adapts to how " +
          "confident the model is, which is why it is usually preferred over a fixed top-k. " +
          "0.95 to 0.99 is the usual range.",
      },
      {
        flag: "--min-p N",
        llamaDefault: "0.05, 0.0 = disabled",
        effect:
          "Drops tokens below a fraction of the best one. Unlike top-p it does not widen " +
          "when the model is unsure, so it is the calmer of the two for factual answers.",
      },
      {
        flag: "--repeat-penalty N",
        fieldKey: "repeatPenalty",
        llamaDefault: "1.0",
        effect:
          "Discourages tokens already present. Above 1 helps with loops and long code " +
          "edits, and above ~1.2 it starts distorting wording and identifiers.",
      },
      {
        flag: "--repeat-last-n, --presence-penalty, --frequency-penalty",
        llamaDefault: "64, 0.00, 0.00 (all disabled)",
        effect:
          "Penalty window and shape. Presence scales with how often a token appeared, " +
          "frequency with how strongly it did; both are OpenAI-style additions to " +
          "repeat-penalty and are rarely needed.",
      },
      {
        flag: "--mirostat N, --mirostat-lr, --mirostat-ent",
        llamaDefault: "0 (disabled), eta 0.10, tau 5.00",
        effect:
          "Keeps a fixed entropy instead of a fixed cutoff, so quality holds up at very low " +
          "temperatures. It replaces top-k, top-p and typical-p while it is on.",
      },
      {
        flag: "--samplers a;b;c",
        llamaDefault: "penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature",
        effect:
          "Which samplers run, and in which order. Temperature is applied last, so it is " +
          "the one that has the last word on the shape of the answer.",
      },
      {
        flag: "--seed N",
        llamaDefault: "random per request",
        effect:
          "Fixes the sampler so the same prompt gives the same answer. Leave it random for " +
          "normal chat; pin it to reproduce a run or compare two configs.",
      },
    ],
  },
  {
    id: "thinking",
    title: "Thinking",
    blurb:
      "Two independent layers: whether the model reasons, and how that reasoning comes back.",
    entries: [
      {
        flag: "reasoning_effort",
        fieldKey: "thinking",
        llamaDefault: "not sent = detected from the model",
        effect:
          "The effort level handed to the chat template. `none` disables thinking outright; " +
          "the other levels only mean something to a template that understands them. " +
          "Leaving it unset is almost always right: llama.cpp then decides from the model.",
      },
      {
        flag: "reasoning_format",
        fieldKey: "reasoning",
        llamaDefault: "auto",
        effect:
          "How the reasoning text is returned. `auto` and `deepseek` put it in " +
          "reasoning_content, streaming deltas included, which is what the collapsible " +
          "Thought block is built on. `none` leaves it inline in the answer text. " +
          "`deepseek-legacy` keeps the <think> tags visible in the answer while streaming, " +
          "so the Thought block stays empty and the tags land in the reply.",
      },
      {
        flag: "-rea, --reasoning on|off|auto",
        llamaDefault: "auto (detect from template)",
        effect:
          "The server-level switch that decides whether thinking is allowed at all. " +
          "Reachable through `extra args`; the request-level effort above is usually the " +
          "finer control.",
      },
      {
        flag: "--reasoning-budget N",
        llamaDefault: "-1 (unrestricted)",
        effect:
          "Caps how many tokens the model may think, so a runaway chain of thought cannot " +
          "eat the whole window. 0 ends thinking immediately.",
      },
      {
        flag: "--reasoning-preserve",
        llamaDefault: "enabled",
        effect:
          "Keeps the reasoning trace in the full history instead of only the last turn. " +
          "Needed by templates that support preserved thinking; costs context room.",
      },
      {
        flag: "chat_template_kwargs",
        llamaDefault: "not sent",
        effect:
          "Per-request template arguments, e.g. {\"enable_thinking\": false} to turn a " +
          "reasoning model into a plain one for a single request. Reachable through " +
          "`extra args` as --chat-template-kwargs.",
      },
      {
        flag: "reasoning_control",
        llamaDefault: "false",
        effect:
          "Arms POST /v1/chat/completions/control so the client can end the thinking phase " +
          "early with action reasoning_end, which saves the tokens a model would have spent " +
          "deliberating.",
      },
    ],
  },
  {
    id: "templates",
    title: "Templates and special tokens",
    blurb: "How turns become a prompt string, and what breaks when it is wrong.",
    entries: [
      {
        flag: "--jinja, --no-jinja",
        fieldKey: "jinja",
        llamaDefault: "enabled",
        effect:
          "Uses the Jinja engine for the chat template. It is the only path that supports " +
          "tool calls and reasoning-aware templates; turning it off falls back to the legacy " +
          "built-in templates and silently loses that support.",
      },
      {
        flag: "--chat-template NAME, --chat-template-file PATH",
        llamaDefault: "the model's own template",
        effect:
          "Overrides the template from the model metadata. Use it when a model ships no " +
          "template, or when its built-in one gets a role or a special token wrong.",
      },
      {
        flag: "--no-context-shift, -cb (see Batching)",
        llamaDefault: "context shift disabled, continuous batching enabled",
        effect:
          "Template and batching choices decide whether a long conversation is refused, " +
          "truncated, or served from a reused prefix. Long sessions are where the " +
          "interaction between these two shows up first.",
      },
    ],
  },
  {
    id: "server",
    title: "Server and endpoints",
    blurb: "What the app reads, and what only the operator needs.",
    entries: [
      {
        flag: "--host, --port",
        fieldKey: "host",
        llamaDefault: "127.0.0.1:8080",
        effect:
          "Where the server listens. Binding 0.0.0.0 exposes the model to the network, so " +
          "pair it with --api-key. LazyLlama appends both flags itself, from the Network " +
          "group, because it is the client that has to reach them.",
      },
      {
        flag: "--props",
        fieldKey: "enableProps",
        llamaDefault: "off (GET is read-only without it)",
        effect:
          "Only POST /props needs this: it lets a client rewrite generation settings at " +
          "runtime. GET /props always works and is what the side panel and the context " +
          "meter read, which is why the row can stay on its default.",
      },
      {
        flag: "--metrics",
        fieldKey: "enableMetrics",
        llamaDefault: "off",
        effect:
          "Exposes /metrics for Prometheus. Nothing in LazyLlama reads it; turn it on only " +
          "when something else scrapes the server.",
      },
      {
        flag: "--slots, --no-slots",
        llamaDefault: "enabled",
        effect:
          "Exposes /slots, the per-slot state the live context meter and the tokens-per-" +
          "second readout are computed from. Turning it off blinds the panel, not the chat.",
      },
      {
        flag: "--api-key KEY",
        llamaDefault: "none",
        effect:
          "Requires this key on every request. Nothing here should ever be exposed without " +
          "one.",
      },
      {
        flag: "--timeout N, --sleep-idle-seconds N",
        llamaDefault: "3600 seconds, -1 (never)",
        effect:
          "A long timeout keeps a slow generation from being cut off. A sleep threshold " +
          "frees VRAM when the server is idle, at the cost of a slow first answer after it " +
          "wakes.",
      },
      {
        flag: "-v, --verbose",
        llamaDefault: "off",
        effect:
          "Full logging. The first thing to add when a model answers badly, since it shows " +
          "the template it actually rendered and the flags it actually took.",
      },
    ],
  },
];

export const MANUAL_ENTRY_COUNT = MANUAL_GROUPS.reduce((total, group) => total + group.entries.length, 0);

/** Field keys the manual documents, for the coverage test against CONFIG_FIELDS. */
export function manualFieldKeys(): string[] {
  const keys: string[] = [];
  for (const group of MANUAL_GROUPS) {
    for (const entry of group.entries) {
      if (entry.fieldKey !== undefined) keys.push(entry.fieldKey);
    }
  }
  return keys;
}

export function manualEntryFor(key: string): ManualEntry | undefined {
  for (const group of MANUAL_GROUPS) {
    for (const entry of group.entries) {
      if (entry.fieldKey === key) return entry;
    }
  }
  return undefined;
}
