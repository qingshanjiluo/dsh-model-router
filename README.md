# dsh-model-router

Deterministic model routing for DeepSeek Harness. The plugin ships a small static
model catalog and exposes it to the model as three pure tools: recommend a model
for a task, compare named models, and price a token budget. No network calls, no
subprocesses, no provider registry — every answer comes from the embedded catalog
and fixed arithmetic, so repeated calls return byte-identical results.

Package: `@qingshanjiluo/dsh-model-router` · Type: host tool plugin (Cordis, `inject: ['tools']`)

## Install

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-model-router
```

## Tools

| Tool | Parameters | Returns |
| --- | --- | --- |
| `model_recommend` | `task` (`chat` \| `code` \| `analysis` \| `summarize` \| `agents` \| `vision`), `needVision` (boolean), `budget` (max USD per task, `0` = configured default) | Best-first `ranked` list with `score`, `estCostUsd`, `context`, `capabilities`, and per-dimension `reasons`; plus `considered`, every `excluded` model with its reason, and `notes`. |
| `model_compare` | `ids` (array of model ids) | Resolved rows sorted by reference price (`context`, `costIn`, `costOut`, `refCostUsd`, `capabilities`), `winners` per dimension, `deltas` cost/context ratios, and `missing` ids. |
| `model_cost` | `id`, `tokensIn`, `tokensOut` | `inputCostUsd` / `outputCostUsd` / `totalCostUsd` for exactly that workload, plus `contextTokens`, `fitsInContext`, and `notes`. Unknown id or negative tokens ⇒ `ok: false` with `error`. |

All three tools are concurrency-safe and validated against a declared output
schema. Argument mistakes are rejected by the tool registry before the body runs.

## How the score is built

Each task kind carries a profile: required capabilities, a target context size, a
typical token mix, and three weights.

```
score = w_capability * capabilityFit + w_cost * costFit + w_context * contextFit
```

* `capabilityFit` — share of the task's required capabilities the model has.
* `costFit` — the model's price for the task's typical token mix, normalized
  linearly across the surviving candidates (cheapest = 1).
* `contextFit` — `min(1, context / targetContext)`.

The score is rounded to 4 decimals and ties break on cheaper, then on catalog id,
so rankings never depend on argument order or locale. `needVision: true` is a hard
filter (non-vision models are excluded, not just penalized), as is `budget`.
With `preferLowCost`, the cost weight doubles and the three weights renormalize.

## Built-in catalog

Prices are USD per 1 000 000 tokens. `model_compare` prices a fixed reference
workload of 9000 input + 1000 output tokens so ratios stay comparable.

| id | context | cost in /M | cost out /M | capabilities |
| --- | --- | --- | --- | --- |
| `deepseek-chat` | 128 000 | 0.27 | 1.10 | text, reasoning, tools, code |
| `deepseek-reasoner` | 64 000 | 0.27 | 1.10 | text, reasoning, code |
| `gpt-4o-mini` | 128 000 | 0.15 | 0.60 | text, vision, tools, code |
| `gpt-4o` | 128 000 | 2.50 | 10.00 | text, vision, tools, code |
| `claude-sonnet-4` | 200 000 | 3.00 | 15.00 | text, vision, reasoning, tools, code |
| `claude-haiku-3.5` | 200 000 | 0.80 | 4.00 | text, vision, tools, code |
| `gemini-flash` | 1 000 000 | 0.10 | 0.40 | text, vision, tools, code |
| `llama-3.3-70b` | 128 000 | 0.60 | 0.60 | text, tools |
| `qwen2.5-coder-32b` | 32 768 | 0 | 0 | text, code (self-hosted, unmetered) |

Ids are matched case- and separator-insensitively (`GPT-4o-Mini` resolves).

## Configuration

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxResults` | number | `5` | Ranked entries returned at most (clamped to `1..catalog size`). |
| `defaultBudgetUsd` | number | `0` | Per-task USD ceiling applied when a call passes `budget: 0`; `0` = unlimited. |
| `preferLowCost` | boolean | `false` | Double the cost dimension of the score, then renormalize the weights. |

## Development

```bash
npm install --no-audit --no-fund
npx tsc --noEmit          # types
npm run build             # lib/index.js + lib/index.d.ts
npx vitest run            # behavior tests (export face + >=2 cases per tool)
node scripts/load-smoke.mjs   # loads lib/index.js and registers the tools
```

## License

MIT
