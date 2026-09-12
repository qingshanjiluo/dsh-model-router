/**
 * Deterministic model router for DeepSeek Harness. Three pure tools rank a
 * built-in static catalog: `model_recommend` scores every model for a task kind
 * (capability fit + cost fit + context fit), `model_compare` puts named models
 * side by side and picks per-dimension winners, and `model_cost` prices one
 * token budget. The catalog ships inside the plugin, so there is no network
 * call, subprocess, or live provider registry anywhere in this file.
 * @module @qingshanjiluo/dsh-model-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-model-router'
export const inject = ['tools']

/** Deployment policy for the router. */
export interface Config {
  /**
   * How many ranked entries `model_recommend` returns at most. Clamped to
   * `[1, catalog size]` at call time.
   */
  maxResults: number
  /**
   * USD ceiling per task applied when a call passes `budget: 0`. `0` means no
   * budget limit.
   */
  defaultBudgetUsd: number
  /** Double the cost dimension of the score, then renormalize the weights. */
  preferLowCost: boolean
}

/** Schemastery configuration for the router. */
export const Config: z<Config> = z.object({
  maxResults: z.number().default(5),
  defaultBudgetUsd: z.number().default(0),
  preferLowCost: z.boolean().default(false),
})

/* ------------------------------------------------------------------- catalog */

const CAPABILITIES = ['text', 'vision', 'reasoning', 'tools', 'code'] as const
type Capability = (typeof CAPABILITIES)[number]

/** One catalog row. `costIn`/`costOut` are USD per 1 000 000 tokens. */
interface ModelEntry {
  readonly id: string
  readonly context: number
  readonly costIn: number
  readonly costOut: number
  readonly capabilities: readonly Capability[]
}

/** Built-in static catalog. Self-hosted rows carry 0 pricing by design. */
const CATALOG: readonly ModelEntry[] = [
  { id: 'deepseek-chat', context: 128_000, costIn: 0.27, costOut: 1.1, capabilities: ['text', 'reasoning', 'tools', 'code'] },
  { id: 'deepseek-reasoner', context: 64_000, costIn: 0.27, costOut: 1.1, capabilities: ['text', 'reasoning', 'code'] },
  { id: 'gpt-4o-mini', context: 128_000, costIn: 0.15, costOut: 0.6, capabilities: ['text', 'vision', 'tools', 'code'] },
  { id: 'gpt-4o', context: 128_000, costIn: 2.5, costOut: 10, capabilities: ['text', 'vision', 'tools', 'code'] },
  { id: 'claude-sonnet-4', context: 200_000, costIn: 3, costOut: 15, capabilities: ['text', 'vision', 'reasoning', 'tools', 'code'] },
  { id: 'claude-haiku-3.5', context: 200_000, costIn: 0.8, costOut: 4, capabilities: ['text', 'vision', 'tools', 'code'] },
  { id: 'gemini-flash', context: 1_000_000, costIn: 0.1, costOut: 0.4, capabilities: ['text', 'vision', 'tools', 'code'] },
  { id: 'llama-3.3-70b', context: 128_000, costIn: 0.6, costOut: 0.6, capabilities: ['text', 'tools'] },
  { id: 'qwen2.5-coder-32b', context: 32_768, costIn: 0, costOut: 0, capabilities: ['text', 'code'] },
]

/** Catalog ids in declared order — reused for "did you mean" hints. */
const CATALOG_IDS: readonly string[] = CATALOG.map(model => model.id)

/** Declared catalog position, so tie-breaks never depend on caller argument order. */
const CATALOG_ORDER = new Map<string, number>(CATALOG.map((model, index) => [model.id, index]))

/** Reference workload for `model_compare`: 9000 input + 1000 output tokens. */
const REF_TOKENS_IN = 9_000
const REF_TOKENS_OUT = 1_000

/**
 * Resolve a caller-supplied id, tolerating case and separator differences so a
 * model writing `GPT-4o-Mini` still hits the catalog row.
 * @param raw - the id as supplied by the caller.
 * @returns the catalog row, or undefined when nothing matches.
 */
function findModel(raw: string): ModelEntry | undefined {
  const exact = CATALOG.find(model => model.id === raw)
  if (exact !== undefined) return exact
  const key = raw.trim().toLowerCase().replace(/[\s_.]+/g, '-')
  return CATALOG.find(model => model.id.toLowerCase() === key)
}

/** ICU-independent ascending id comparator, so ranks never depend on locale. */
function byIdAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/* ------------------------------------------------------------- task profiles */

const TASKS = ['chat', 'code', 'analysis', 'summarize', 'agents', 'vision'] as const
type TaskKind = (typeof TASKS)[number]

/** Deterministic shape of one task kind: needs, typical size, score weights. */
interface TaskProfile {
  readonly required: readonly Capability[]
  readonly minContext: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly capability: number
  readonly cost: number
  readonly context: number
}

const TASK_PROFILES: Record<TaskKind, TaskProfile> = {
  chat: { required: ['text'], minContext: 8_192, inputTokens: 800, outputTokens: 600, capability: 0.4, cost: 0.4, context: 0.2 },
  code: { required: ['text', 'code'], minContext: 32_768, inputTokens: 6_000, outputTokens: 2_500, capability: 0.5, cost: 0.3, context: 0.2 },
  analysis: { required: ['text', 'reasoning'], minContext: 64_000, inputTokens: 40_000, outputTokens: 4_000, capability: 0.5, cost: 0.25, context: 0.25 },
  summarize: { required: ['text'], minContext: 128_000, inputTokens: 100_000, outputTokens: 2_000, capability: 0.3, cost: 0.4, context: 0.3 },
  agents: { required: ['text', 'tools'], minContext: 64_000, inputTokens: 20_000, outputTokens: 2_000, capability: 0.5, cost: 0.3, context: 0.2 },
  vision: { required: ['text', 'vision'], minContext: 16_384, inputTokens: 3_000, outputTokens: 800, capability: 0.5, cost: 0.3, context: 0.2 },
}

/* ------------------------------------------------------------------ numerics */

/** Round to a fixed number of decimals so scores are byte-stable. */
function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  const scaled = Math.round(value * factor) / factor
  return Object.is(scaled, -0) ? 0 : scaled
}

/** USD price of an explicit token budget (catalog prices are per 1M tokens). */
function price(model: ModelEntry, tokensIn: number, tokensOut: number): { input: number; output: number; total: number } {
  const input = (Math.max(0, tokensIn) / 1_000_000) * model.costIn
  const output = (Math.max(0, tokensOut) / 1_000_000) * model.costOut
  return { input: round(input, 6), output: round(output, 6), total: round(input + output, 6) }
}

/** `$0.013500` text for a USD amount. */
function usd(value: number): string {
  return `$${Math.max(0, value).toFixed(6)}`
}

/* ----------------------------------------------------------------- scoring */

interface RankedEntry {
  readonly id: string
  readonly score: number
  readonly estCostUsd: number
  readonly context: number
  readonly capabilities: readonly string[]
  readonly reasons: readonly string[]
}

interface ScorePass {
  readonly ranked: RankedEntry[]
  readonly excluded: readonly { id: string; reason: string }[]
  readonly considered: number
}

/**
 * Filter then score the whole catalog for one task profile.
 *
 * Filters (in order): the `needVision` capability requirement, then the
 * per-task budget ceiling. Score is a weighted sum of capability fit, cost fit
 * (linearly normalized across the surviving set), and context fit, rounded to
 * 4 decimals; ties break on cheaper, then on id.
 *
 * @param profile - the task profile being matched.
 * @param needVision - hard-require the `vision` capability.
 * @param budgetUsd - per-task ceiling; `0` disables the budget filter.
 * @param preferLowCost - double the cost weight, then renormalize.
 * @returns best-first ranking, every exclusion with its reason, and the size of the surviving set.
 */
function scoreCatalog(profile: TaskProfile, needVision: boolean, budgetUsd: number, preferLowCost: boolean): ScorePass {
  const required: readonly Capability[] = needVision && !profile.required.includes('vision')
    ? [...profile.required, 'vision' as Capability]
    : profile.required

  const excluded: { id: string; reason: string }[] = []

  const candidates: ModelEntry[] = []
  for (const model of CATALOG) {
    if (needVision && !model.capabilities.includes('vision')) {
      excluded.push({ id: model.id, reason: 'no vision capability' })
      continue
    }
    candidates.push(model)
  }

  const estimates = new Map<string, number>()
  for (const model of candidates) estimates.set(model.id, price(model, profile.inputTokens, profile.outputTokens).total)

  const surviving: ModelEntry[] = []
  for (const model of candidates) {
    const est = estimates.get(model.id)!
    if (budgetUsd > 0 && est > budgetUsd) {
      excluded.push({ id: model.id, reason: `${usd(est)} for this task exceeds the ${usd(budgetUsd)} budget` })
      continue
    }
    surviving.push(model)
  }
  if (surviving.length === 0) return { ranked: [], excluded, considered: 0 }

  let cheapest = Infinity
  let dearest = -Infinity
  for (const model of surviving) {
    const est = estimates.get(model.id)!
    if (est < cheapest) cheapest = est
    if (est > dearest) dearest = est
  }

  const rawCap = profile.capability
  const rawCost = preferLowCost ? profile.cost * 2 : profile.cost
  const rawCtx = profile.context
  const rawSum = rawCap + rawCost + rawCtx || 1
  const wCap = rawCap / rawSum
  const wCost = rawCost / rawSum
  const wCtx = rawCtx / rawSum

  const ranked: RankedEntry[] = []
  for (const model of surviving) {
    const est = estimates.get(model.id)!
    const missing = required.filter(cap => !model.capabilities.includes(cap))
    const capScore = required.length === 0 ? 1 : (required.length - missing.length) / required.length
    const costScore = dearest - cheapest <= 0 ? 1 : (dearest - est) / (dearest - cheapest)
    const ctxScore = Math.min(1, model.context / profile.minContext)
    const reasons: string[] = [
      `est. ${usd(est)} for ${profile.inputTokens} in + ${profile.outputTokens} out`,
      missing.length === 0
        ? `has ${required.join(' + ')}`
        : `missing ${missing.join(', ')}`,
      model.context >= profile.minContext
        ? `context ${model.context} covers the ${profile.minContext} target`
        : `context ${model.context} below the ${profile.minContext} target`,
    ]
    if (model.costIn === 0 && model.costOut === 0) reasons.push('self-hosted: token prices are 0')
    ranked.push({
      id: model.id,
      score: round(wCap * capScore + wCost * costScore + wCtx * ctxScore, 4),
      estCostUsd: est,
      context: model.context,
      capabilities: [...model.capabilities],
      reasons,
    })
  }

  ranked.sort((a, b) => b.score - a.score || a.estCostUsd - b.estCostUsd || byIdAsc(a.id, b.id))
  return { ranked, excluded, considered: surviving.length }
}

/** Clamp the operator's `maxResults` into a usable slice length. */
function clampMax(value: number, size: number): number {
  const n = Number.isFinite(value) ? Math.floor(value) : 5
  return Math.min(Math.max(1, n), size)
}

/* -------------------------------------------------------------------- tools */

/**
 * Register the router tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit routing policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'model_recommend',
    description:
      'Rank the built-in static model catalog for one task kind, best first, with ' +
      'a deterministic score = capability fit + cost fit + context fit (weights ' +
      'come from the task profile). Parameters: task is one of "chat" (general ' +
      'Q&A), "code" (writing/refactoring code), "analysis" (long multi-step ' +
      'reasoning), "summarize" (very large input), "agents" (tool-using loops), ' +
      '"vision" (image input); needVision=true hard-requires image input and ' +
      'drops non-vision models; budget is the max USD per task and drops anything ' +
      'priced above it — pass 0 to fall back to the configured default (0 = no ' +
      'limit). Every dropped model is reported under `excluded` with its reason.',
    parameters: {
      task: { type: 'string', required: true, enum: [...TASKS], description: 'Task kind selecting the capability needs, typical token mix, and score weights.' },
      needVision: { type: 'boolean', required: true, description: 'True to require image input and exclude models without vision.' },
      budget: { type: 'number', required: true, description: 'Max USD per task; models priced above it are excluded. 0 = use the configured default (0 = unlimited).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether at least one model survived the filters.' },
          task: { type: 'string', required: true, description: 'The task profile that was applied.' },
          budgetUsd: { type: 'number', required: true, description: 'Effective USD-per-task ceiling after defaults; 0 = unlimited.' },
          considered: { type: 'integer', required: true, description: 'Catalog models that passed every filter and were scored.' },
          ranked: {
            type: 'array',
            required: true,
            description: 'Best first, truncated to the configured maxResults.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Catalog model id.' },
                score: { type: 'number', required: true, description: 'Composite score in [0,1]; higher is better.' },
                estCostUsd: { type: 'number', required: true, description: 'Estimated USD for this task profile\'s typical token mix.' },
                context: { type: 'integer', required: true, description: 'Context window in tokens.' },
                capabilities: { type: 'array', required: true, description: 'Capability tags of this model.', items: { type: 'string' } },
                reasons: {
                  type: 'array',
                  required: true,
                  description: 'Deterministic justification lines, one per scored dimension.',
                  items: { type: 'string' },
                },
              },
            },
          },
          excluded: {
            type: 'array',
            required: true,
            description: 'Every model dropped before scoring, with its reason.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Catalog model id.' },
                reason: { type: 'string', required: true, description: 'Why it was dropped.' },
              },
            },
          },
          notes: { type: 'array', required: true, description: 'Advisories; empty in the normal case.', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.ranked.length === 0) {
          const why = value.notes.length > 0 ? value.notes.join('; ') : `${value.excluded.length} model(s) excluded`
          return [{ type: 'text', text: `model_recommend("${value.task}"): no model fits — ${why}` }]
        }
        const head = `Task "${value.task}" — ${value.considered} candidate(s), budget ${value.budgetUsd > 0 ? usd(value.budgetUsd) : 'none'}:`
        const lines = value.ranked.map((entry, index) =>
          `${index + 1}. ${entry.id}  score=${entry.score.toFixed(4)}  est=${usd(entry.estCostUsd)}  ctx=${entry.context}  [${entry.capabilities.join(', ')}]`)
        const parts = [head, ...lines]
        if (value.excluded.length > 0) parts.push(`excluded: ${value.excluded.map(e => `${e.id} (${e.reason})`).join('; ')}`)
        if (value.notes.length > 0) parts.push(`note: ${value.notes.join('; ')}`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const profile = TASK_PROFILES[args.task] ?? TASK_PROFILES.chat
      const budgetUsd = args.budget > 0 ? args.budget : Math.max(0, config.defaultBudgetUsd)
      const { ranked, excluded, considered } = scoreCatalog(profile, args.needVision, budgetUsd, config.preferLowCost)
      const limit = clampMax(config.maxResults, CATALOG.length)
      const visible = ranked.slice(0, limit)

      const notes: string[] = []
      if (ranked.length === 0) {
        notes.push(budgetUsd > 0
          ? `no catalog model stays under the ${usd(budgetUsd)} per-task budget`
          : 'no catalog model survived the filters')
      } else if (ranked.length > visible.length) {
        notes.push(`showing ${visible.length} of ${ranked.length} scored models (maxResults=${limit})`)
      }
      if (budgetUsd === 0 && config.preferLowCost) notes.push('preferLowCost is on: the cost dimension is doubled')

      return Promise.resolve({
        ok: ranked.length > 0,
        task: args.task,
        budgetUsd: round(budgetUsd, 6),
        considered,
        ranked: visible.map(entry => ({
          id: entry.id,
          score: entry.score,
          estCostUsd: entry.estCostUsd,
          context: entry.context,
          capabilities: [...entry.capabilities],
          reasons: [...entry.reasons],
        })),
        excluded: excluded.map(entry => ({ id: entry.id, reason: entry.reason })),
        notes,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'model_compare',
    description:
      'Compare named models from the built-in catalog side by side. Parameters: ' +
      'ids is the list to contrast, for example ["deepseek-chat", "gpt-4o", ' +
      '"gemini-flash"] — pass two or more for a real contrast; unknown ids are ' +
      'reported under `missing` instead of failing the call, and pricing is USD ' +
      'per 1M tokens. Every row also carries `refCostUsd`, the price of a fixed ' +
      '9000-in + 1000-out reference workload, which is what the winners and cost ' +
      'ratios use, so models cannot be compared on raw per-token numbers alone. ' +
      '`winners` names the best model per dimension (ties break on catalog ' +
      'order).',
    parameters: {
      ids: { type: 'array', required: true, description: 'Model ids to compare (two or more for a real contrast).', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether at least one requested id resolved.' },
          found: {
            type: 'array',
            required: true,
            description: 'Resolved rows, ascending by reference price.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Catalog model id.' },
                context: { type: 'integer', required: true, description: 'Context window in tokens.' },
                costIn: { type: 'number', required: true, description: 'USD per 1M input tokens.' },
                costOut: { type: 'number', required: true, description: 'USD per 1M output tokens.' },
                refCostUsd: { type: 'number', required: true, description: `USD for the ${REF_TOKENS_IN} in + ${REF_TOKENS_OUT} out reference workload.` },
                capabilities: { type: 'array', required: true, description: 'Capability tags of this model.', items: { type: 'string' } },
              },
            },
          },
          missing: { type: 'array', required: true, description: 'Requested ids that are not in the catalog.', items: { type: 'string' } },
          winners: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              lowestCost: { type: 'string', required: true, description: 'Cheapest on the reference workload; "" when nothing resolved.' },
              longestContext: { type: 'string', required: true, description: 'Largest context window; "" when nothing resolved.' },
              mostCapabilities: { type: 'string', required: true, description: 'Most capability tags; "" when nothing resolved.' },
            },
          },
          deltas: { type: 'array', required: true, description: 'Cost and context ratio lines versus the cheapest and smallest resolved model; empty below two rows.', items: { type: 'string' } },
          notes: { type: 'array', required: true, description: 'Advisories such as an under-sized comparison set.', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.found.length === 0) {
          return [{ type: 'text', text: `model_compare: nothing to compare — unknown id(s): ${value.missing.join(', ')}` }]
        }
        const lines = value.found.map(entry =>
          `${entry.id}: ctx=${entry.context} in=$${entry.costIn}/M out=$${entry.costOut}/M ref=${usd(entry.refCostUsd)} [${entry.capabilities.join(', ')}]`)
        const winners = `winners: cost=${value.winners.lowestCost || '—'} context=${value.winners.longestContext || '—'} capability=${value.winners.mostCapabilities || '—'}`
        const parts = [...lines, winners, ...value.deltas.map(delta => `- ${delta}`)]
        if (value.missing.length > 0) parts.push(`- missing: ${value.missing.join(', ')}`)
        if (value.notes.length > 0) parts.push(`note: ${value.notes.join('; ')}`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const missing: string[] = []
      const resolved: ModelEntry[] = []
      for (const raw of args.ids) {
        const model = findModel(raw)
        if (model === undefined) {
          if (!missing.includes(raw)) missing.push(raw)
          continue
        }
        if (!resolved.some(entry => entry.id === model.id)) resolved.push(model)
      }

      // Scan in catalog order, never caller order, so tied winners are stable.
      resolved.sort((a, b) => CATALOG_ORDER.get(a.id)! - CATALOG_ORDER.get(b.id)!)

      const found = resolved.map(model => ({
        id: model.id,
        context: model.context,
        costIn: model.costIn,
        costOut: model.costOut,
        refCostUsd: price(model, REF_TOKENS_IN, REF_TOKENS_OUT).total,
        capabilities: [...model.capabilities],
      }))
      found.sort((a, b) => a.refCostUsd - b.refCostUsd || byIdAsc(a.id, b.id))

      const notes: string[] = []
      if (resolved.length === 0) notes.push('no requested id is in the catalog')
      else if (resolved.length < 2) notes.push('pass at least two ids for a real contrast')
      if (missing.length > 0) notes.push(`known ids: ${CATALOG_IDS.join(', ')}`)

      // First match wins each dimension, and the scan follows catalog order, so
      // ties resolve deterministically without a locale-dependent comparator.
      let longestContext = ''
      let bestCtx = -1
      let mostCapabilities = ''
      let bestCaps = -1
      for (const model of resolved) {
        if (model.context > bestCtx) {
          bestCtx = model.context
          longestContext = model.id
        }
        const size = model.capabilities.length
        if (size > bestCaps) {
          bestCaps = size
          mostCapabilities = model.id
        }
      }

      const deltas: string[] = []
      if (found.length >= 2) {
        const baseline = found[0]!
        const smallestCtx = Math.min(...found.map(entry => entry.context))
        for (const row of found.slice(1)) {
          const relation = baseline.refCostUsd <= 0
            ? row.refCostUsd <= 0 ? 'also free' : 'priced while the baseline is free'
            : `${round(row.refCostUsd / baseline.refCostUsd, 2)}x the cost of ${baseline.id}`
          deltas.push(`cost — ${row.id}: ${usd(row.refCostUsd)} vs ${usd(baseline.refCostUsd)} (${relation})`)
        }
        for (const row of found.filter(entry => entry.context > smallestCtx).sort((a, b) => b.context - a.context || byIdAsc(a.id, b.id))) {
          deltas.push(`context — ${row.id}: ${round(row.context / smallestCtx, 2)}x the ${smallestCtx} token minimum`)
        }
      }

      return Promise.resolve({
        ok: found.length > 0,
        found,
        missing,
        winners: { lowestCost: found.length > 0 ? found[0]!.id : '', longestContext, mostCapabilities },
        deltas,
        notes,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'model_cost',
    description:
      'Price an explicit token budget on one catalog model. Parameters: id is the ' +
      'catalog model (case/separator insensitive), tokensIn and tokensOut are the ' +
      'token counts to bill. Catalog prices are USD per 1M tokens, so the result ' +
      'is the exact USD cost of that workload, split into inputCostUsd / ' +
      'outputCostUsd plus the total. The tool also says whether tokensIn fits the ' +
      'model context window. Unknown ids and negative token counts return ' +
      'ok=false with an explanatory `error` rather than throwing.',
    parameters: {
      id: { type: 'string', required: true, description: 'Catalog model id to price.' },
      tokensIn: { type: 'number', required: true, description: 'Input tokens billed (prompt, including any cached prefix).' },
      tokensOut: { type: 'number', required: true, description: 'Output tokens billed (completion).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the model resolved and the token counts were usable.' },
          id: { type: 'string', required: true, description: 'Resolved catalog id, or the raw id when unknown.' },
          error: { type: 'string', required: true, description: 'Failure reason; empty when ok.' },
          tokensIn: { type: 'integer', required: true, description: 'Input tokens billed (0 on failure).' },
          tokensOut: { type: 'integer', required: true, description: 'Output tokens billed (0 on failure).' },
          inputCostUsd: { type: 'number', required: true, description: 'USD for the input side.' },
          outputCostUsd: { type: 'number', required: true, description: 'USD for the output side.' },
          totalCostUsd: { type: 'number', required: true, description: 'inputCostUsd + outputCostUsd.' },
          contextTokens: { type: 'integer', required: true, description: 'Model context window (0 when the id is unknown).' },
          fitsInContext: { type: 'boolean', required: true, description: 'Whether tokensIn fits the context window.' },
          notes: { type: 'array', required: true, description: 'Advisories such as truncation, free-tier pricing, or an over-long prompt.', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `model_cost failed: ${value.error}` }]
        const lines = [
          `${value.id}: ${usd(value.inputCostUsd)} in (${value.tokensIn} tok) + ${usd(value.outputCostUsd)} out (${value.tokensOut} tok) = ${usd(value.totalCostUsd)}`,
          value.fitsInContext
            ? `input fits the ${value.contextTokens} token context window`
            : `input exceeds the ${value.contextTokens} token context window`,
        ]
        if (value.notes.length > 0) lines.push(`note: ${value.notes.join('; ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const model = findModel(args.id)
      if (model === undefined) {
        return Promise.resolve({
          ok: false,
          id: args.id,
          error: `unknown model "${args.id}"; known ids: ${CATALOG_IDS.join(', ')}`,
          tokensIn: 0,
          tokensOut: 0,
          inputCostUsd: 0,
          outputCostUsd: 0,
          totalCostUsd: 0,
          contextTokens: 0,
          fitsInContext: false,
          notes: [],
        })
      }
      if (args.tokensIn < 0 || args.tokensOut < 0) {
        return Promise.resolve({
          ok: false,
          id: model.id,
          error: `token counts must not be negative (got tokensIn=${args.tokensIn}, tokensOut=${args.tokensOut})`,
          tokensIn: 0,
          tokensOut: 0,
          inputCostUsd: 0,
          outputCostUsd: 0,
          totalCostUsd: 0,
          contextTokens: model.context,
          fitsInContext: false,
          notes: [],
        })
      }

      const tokensIn = Math.floor(args.tokensIn)
      const tokensOut = Math.floor(args.tokensOut)
      const notes: string[] = []
      if (tokensIn !== args.tokensIn) notes.push(`tokensIn truncated from ${args.tokensIn} to ${tokensIn}`)
      if (tokensOut !== args.tokensOut) notes.push(`tokensOut truncated from ${args.tokensOut} to ${tokensOut}`)
      if (model.costIn === 0 && model.costOut === 0) notes.push('self-hosted row: token prices are 0, so cost reflects hardware, not a meter')

      const fitsInContext = tokensIn <= model.context
      if (!fitsInContext) notes.push(`only ${model.context} input tokens fit; the total prices the whole request as given`)

      const cost = price(model, tokensIn, tokensOut)
      return Promise.resolve({
        ok: true,
        id: model.id,
        error: '',
        tokensIn,
        tokensOut,
        inputCostUsd: cost.input,
        outputCostUsd: cost.output,
        totalCostUsd: cost.total,
        contextTokens: model.context,
        fitsInContext,
        notes,
      })
    },
  }))
}
