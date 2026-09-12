import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'

interface RegisteredTool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render(args: never, value: never): { type: string; text: string }[] }
  isConcurrencySafe(args: never): boolean
  execute(args: never, exec?: never): Promise<Record<string, any>>
}

interface RouterConfig {
  maxResults: number
  defaultBudgetUsd: number
  preferLowCost: boolean
}

const DEFAULTS: RouterConfig = { maxResults: 5, defaultBudgetUsd: 0, preferLowCost: false }

/** One schema-valid argument set per tool, for the concurrency-safety probe. */
const SAMPLE_ARGS: Record<string, unknown> = {
  model_recommend: { task: 'chat', needVision: false, budget: 0 },
  model_compare: { ids: ['gpt-4o', 'gpt-4o-mini'] },
  model_cost: { id: 'gpt-4o', tokensIn: 100, tokensOut: 50 },
}

function mount(config: Partial<RouterConfig> = {}): RegisteredTool[] {
  const registered: RegisteredTool[] = []
  const ctx = { tools: { register: (def: RegisteredTool) => registered.push(def) } }
  // The plugin only touches ctx.tools, so this stub is the whole registrant surface.
  apply(ctx as never, { ...DEFAULTS, ...config } as never)
  return registered
}

const toolNamed = (name: string, config?: Partial<RouterConfig>): RegisteredTool =>
  mount(config).find(tool => tool.name === name)!

describe('dsh-model-router plugin contract', () => {
  it('exports the Cordis function-plugin face', () => {
    expect(name).toBe('dsh-model-router')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeInstanceOf(Object)
  })

  it('registers the three documented tools, each with a complete definition', () => {
    const tools = mount()
    expect(tools.map(tool => tool.name).sort()).toEqual(['model_compare', 'model_cost', 'model_recommend'])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(60)
      expect(tool.parameters).toBeInstanceOf(Object)
      expect(tool.output.schema).toBeInstanceOf(Object)
      expect(typeof tool.output.render).toBe('function')
      expect(typeof tool.execute).toBe('function')
      // The registry only reports overlap-safety for schema-valid arguments.
      expect(tool.isConcurrencySafe(SAMPLE_ARGS[tool.name] as never)).toBe(true)
      expect(tool.isConcurrencySafe({ notAToolArgument: true } as never)).toBe(false)
    }
  })
})

describe('model_recommend', () => {
  it('ranks the cheapest wide-context model first for a summarize task', async () => {
    const result = await toolNamed('model_recommend').execute(
      { task: 'summarize', needVision: false, budget: 0 } as never,
    ) as { ok: boolean; ranked: { id: string; score: number }[]; considered: number }
    expect(result.ok).toBe(true)
    expect(result.considered).toBe(9)
    expect(result.ranked[0]!.id).toBe('gemini-flash')
    // Scores are non-increasing and the list is capped by maxResults.
    expect(result.ranked.length).toBe(5)
    const scores = result.ranked.map(entry => entry.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('names deepseek-chat for analysis and gemini-flash for agents', async () => {
    const tool = toolNamed('model_recommend')
    const analysis = await tool.execute({ task: 'analysis', needVision: false, budget: 0 } as never) as { ranked: { id: string }[] }
    const agents = await tool.execute({ task: 'agents', needVision: false, budget: 0 } as never) as { ranked: { id: string }[] }
    expect(analysis.ranked[0]!.id).toBe('deepseek-chat')
    expect(agents.ranked[0]!.id).toBe('gemini-flash')
  })

  it('is deterministic: the same call repeats byte-for-byte', async () => {
    const tool = toolNamed('model_recommend')
    const args = { task: 'code', needVision: false, budget: 0 } as never
    expect(await tool.execute(args)).toEqual(await tool.execute(args))
  })

  it('hard-excludes non-vision models when needVision is true', async () => {
    const result = await toolNamed('model_recommend').execute(
      { task: 'chat', needVision: true, budget: 0 } as never,
    ) as { ranked: { capabilities: string[] }[]; excluded: { id: string; reason: string }[] }
    expect(result.excluded.map(entry => entry.id).sort()).toEqual(
      ['deepseek-chat', 'deepseek-reasoner', 'llama-3.3-70b', 'qwen2.5-coder-32b'],
    )
    expect(result.excluded.every(entry => entry.reason === 'no vision capability')).toBe(true)
    expect(result.ranked.every(entry => entry.capabilities.includes('vision'))).toBe(true)
  })

  it('drops over-budget candidates and reports an empty ranking when nothing fits', async () => {
    const tool = toolNamed('model_recommend')
    const partial = await tool.execute({ task: 'agents', needVision: false, budget: 0.003 } as never) as {
      ok: boolean
      considered: number
      ranked: { id: string }[]
      excluded: { reason: string }[]
      budgetUsd: number
    }
    expect(partial.budgetUsd).toBe(0.003)
    expect(partial.considered).toBe(2)
    expect(partial.ranked.map(entry => entry.id)).toEqual(['gemini-flash', 'qwen2.5-coder-32b'])
    expect(partial.excluded.every(entry => entry.reason.includes('budget'))).toBe(true)

    const none = await tool.execute({ task: 'chat', needVision: true, budget: 0.0001 } as never) as {
      ok: boolean
      ranked: unknown[]
      notes: string[]
    }
    expect(none.ok).toBe(false)
    expect(none.ranked).toEqual([])
    expect(none.notes[0]).toContain('budget')
  })

  it('honors maxResults and doubles the cost weight when preferLowCost is on', async () => {
    const clamped = await toolNamed('model_recommend', { maxResults: 1 }).execute(
      { task: 'chat', needVision: false, budget: 0 } as never,
    ) as { ranked: unknown[]; notes: string[] }
    expect(clamped.ranked.length).toBe(1)
    expect(clamped.notes.join(' ')).toContain('showing 1 of 9')

    const args = { task: 'analysis', needVision: false, budget: 0 } as never
    const plain = await toolNamed('model_recommend').execute(args) as { ranked: { id: string }[] }
    const cheap = await toolNamed('model_recommend', { preferLowCost: true }).execute(args) as { ranked: { id: string }[]; notes: string[] }
    // Doubling the cost dimension pushes the dearest in-window model out of the
    // top five and promotes the cheap wide-context rows.
    expect(plain.ranked.map(entry => entry.id))
      .toEqual(['deepseek-chat', 'deepseek-reasoner', 'claude-sonnet-4', 'gemini-flash', 'gpt-4o-mini'])
    expect(cheap.ranked.map(entry => entry.id))
      .toEqual(['deepseek-chat', 'deepseek-reasoner', 'gemini-flash', 'gpt-4o-mini', 'llama-3.3-70b'])
    expect(cheap.notes.join(' ')).toContain('preferLowCost is on')
  })

  it('falls back to the configured default budget when budget is 0', async () => {
    const result = await toolNamed('model_recommend', { defaultBudgetUsd: 0.003 }).execute(
      { task: 'agents', needVision: false, budget: 0 } as never,
    ) as { budgetUsd: number; considered: number }
    expect(result.budgetUsd).toBe(0.003)
    expect(result.considered).toBe(2)
  })

  it('rejects a task outside the declared enum through the real argument validator', async () => {
    await expect(toolNamed('model_recommend').execute(
      { task: 'telepathy', needVision: false, budget: 0 } as never,
    )).rejects.toThrow(/telepathy|invalid arguments/i)
  })

  it('renders a numbered ranking for the model transcript', async () => {
    const tool = toolNamed('model_recommend')
    const value = await tool.execute({ task: 'vision', needVision: false, budget: 0 } as never)
    const blocks = tool.output.render({ task: 'vision', needVision: false, budget: 0 } as never, value as never)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('1. gemini-flash')
    expect(blocks[0]!.text).toContain('score=')
  })
})

describe('model_compare', () => {
  it('orders rows by reference price and names per-dimension winners', async () => {
    const result = await toolNamed('model_compare').execute(
      { ids: ['gpt-4o', 'gpt-4o-mini', 'gemini-flash'] } as never,
    ) as {
      ok: boolean
      found: { id: string; refCostUsd: number }[]
      winners: { lowestCost: string; longestContext: string; mostCapabilities: string }
      deltas: string[]
    }
    expect(result.ok).toBe(true)
    expect(result.found.map(entry => entry.id)).toEqual(['gemini-flash', 'gpt-4o-mini', 'gpt-4o'])
    expect(result.winners.lowestCost).toBe('gemini-flash')
    expect(result.winners.longestContext).toBe('gemini-flash')
    // Capability counts tie at four everywhere here, so the catalog order wins.
    expect(result.winners.mostCapabilities).toBe('gpt-4o-mini')
    expect(result.deltas[0]).toContain('cost — gpt-4o-mini')
    expect(result.deltas.some(line => line.includes('25x the cost of gemini-flash'))).toBe(true)
  })

  it('resolves ids case- and separator-insensitively, and deduplicates', async () => {
    const result = await toolNamed('model_compare').execute(
      { ids: ['GPT-4o-Mini', 'gpt.4o.mini', 'claude-sonnet-4'] } as never,
    ) as { found: { id: string }[]; missing: string[] }
    expect(result.found.map(entry => entry.id)).toEqual(['gpt-4o-mini', 'claude-sonnet-4'])
    expect(result.missing).toEqual([])
  })

  it('reports unknown ids as missing instead of failing', async () => {
    const result = await toolNamed('model_compare').execute({ ids: ['gpt-4o', 'gpt-18-turbo'] } as never) as {
      ok: boolean
      missing: string[]
      notes: string[]
    }
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual(['gpt-18-turbo'])
    expect(result.notes.join(' ')).toContain('known ids:')
  })

  it('degrades cleanly for an all-unknown list and a single model', async () => {
    const none = await toolNamed('model_compare').execute({ ids: ['nope-1', 'nope-2'] } as never) as {
      ok: boolean
      found: unknown[]
      missing: string[]
      winners: { lowestCost: string; longestContext: string; mostCapabilities: string }
      deltas: unknown[]
    }
    expect(none.ok).toBe(false)
    expect(none.found).toEqual([])
    expect(none.missing).toEqual(['nope-1', 'nope-2'])
    expect(none.winners).toEqual({ lowestCost: '', longestContext: '', mostCapabilities: '' })
    expect(none.deltas).toEqual([])

    const single = await toolNamed('model_compare').execute({ ids: ['deepseek-chat'] } as never) as {
      deltas: unknown[]
      notes: string[]
      winners: { lowestCost: string }
    }
    expect(single.deltas).toEqual([])
    expect(single.winners.lowestCost).toBe('deepseek-chat')
    expect(single.notes.join(' ')).toContain('at least two ids')
  })

  it('says so when a free self-hosted row is the baseline', async () => {
    const result = await toolNamed('model_compare').execute({ ids: ['qwen2.5-coder-32b', 'gpt-4o'] } as never) as {
      found: { id: string; refCostUsd: number }[]
      deltas: string[]
    }
    expect(result.found[0]!.id).toBe('qwen2.5-coder-32b')
    expect(result.found[0]!.refCostUsd).toBe(0)
    expect(result.deltas[0]).toContain('priced while the baseline is free')
  })

  it('renders a per-row table with the winners line', async () => {
    const tool = toolNamed('model_compare')
    const value = await tool.execute({ ids: ['gpt-4o', 'gpt-4o-mini'] } as never)
    const blocks = tool.output.render({ ids: ['gpt-4o', 'gpt-4o-mini'] } as never, value as never)
    expect(blocks[0]!.text).toContain('winners: cost=gpt-4o-mini')
    expect(blocks[0]!.text).toContain('ctx=128000')
  })
})

describe('model_cost', () => {
  it('prices a token budget exactly (USD per 1M tokens)', async () => {
    const result = await toolNamed('model_cost').execute(
      { id: 'gpt-4o', tokensIn: 1_000, tokensOut: 500 } as never,
    ) as {
      ok: boolean
      id: string
      error: string
      inputCostUsd: number
      outputCostUsd: number
      totalCostUsd: number
      contextTokens: number
      fitsInContext: boolean
    }
    expect(result.ok).toBe(true)
    expect(result.error).toBe('')
    expect(result.inputCostUsd).toBeCloseTo(0.0025, 9)
    expect(result.outputCostUsd).toBeCloseTo(0.005, 9)
    expect(result.totalCostUsd).toBeCloseTo(0.0075, 9)
    expect(result.contextTokens).toBe(128_000)
    expect(result.fitsInContext).toBe(true)
  })

  it('flags an input that overflows the context window', async () => {
    const result = await toolNamed('model_cost').execute(
      { id: 'gpt-4o', tokensIn: 5_000_000, tokensOut: 0 } as never,
    ) as { ok: boolean; fitsInContext: boolean; notes: string[]; inputCostUsd: number }
    expect(result.ok).toBe(true)
    expect(result.fitsInContext).toBe(false)
    expect(result.inputCostUsd).toBeCloseTo(12.5, 9)
    expect(result.notes.join(' ')).toContain('only 128000 input tokens fit')
  })

  it('prices a free self-hosted row and truncates fractional tokens', async () => {
    const result = await toolNamed('model_cost').execute(
      { id: 'qwen2.5-coder-32b', tokensIn: 1234.7, tokensOut: 56.2 } as never,
    ) as { ok: boolean; tokensIn: number; tokensOut: number; totalCostUsd: number; notes: string[] }
    expect(result.ok).toBe(true)
    expect(result.tokensIn).toBe(1234)
    expect(result.tokensOut).toBe(56)
    expect(result.totalCostUsd).toBe(0)
    expect(result.notes.join(' ')).toContain('truncated')
    expect(result.notes.join(' ')).toContain('self-hosted')
  })

  it('returns ok=false with a hint for an unknown model', async () => {
    const result = await toolNamed('model_cost').execute(
      { id: 'gpt-4o-mini-max-ultra', tokensIn: 100, tokensOut: 100 } as never,
    ) as { ok: boolean; id: string; error: string; totalCostUsd: number; contextTokens: number }
    expect(result.ok).toBe(false)
    expect(result.id).toBe('gpt-4o-mini-max-ultra')
    expect(result.error).toContain('unknown model')
    expect(result.error).toContain('deepseek-chat')
    expect(result.totalCostUsd).toBe(0)
    expect(result.contextTokens).toBe(0)
  })

  it('rejects negative token counts without throwing', async () => {
    const result = await toolNamed('model_cost').execute(
      { id: 'deepseek-chat', tokensIn: -5, tokensOut: 10 } as never,
    ) as { ok: boolean; error: string; inputCostUsd: number; contextTokens: number }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('must not be negative')
    expect(result.inputCostUsd).toBe(0)
    expect(result.contextTokens).toBe(128_000)
  })

  it('renders the failure line when ok is false', async () => {
    const tool = toolNamed('model_cost')
    const value = await tool.execute({ id: 'nope', tokensIn: 1, tokensOut: 1 } as never)
    const blocks = tool.output.render({ id: 'nope', tokensIn: 1, tokensOut: 1 } as never, value as never)
    expect(blocks[0]!.text).toContain('model_cost failed: unknown model "nope"')
  })
})
