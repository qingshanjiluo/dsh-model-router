/**
 * Loads the built artifact and asserts it exports the Cordis function-plugin
 * face the harness loader requires, then registers every tool against a stub
 * registry and exercises one call per tool. Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'dsh-model-router', 'plugin name export')
assert.deepEqual(mod.inject, ['tools'], 'inject declares the tools service')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config schema export present')
// Schemastery schemas are callable objects; assert the declared fields.
assert.equal(typeof mod.Config, 'function', 'Config is a schemastery schema')
assert.deepEqual(
  Object.keys(mod.Config.dict).sort(),
  ['defaultBudgetUsd', 'maxResults', 'preferLowCost'],
  'Config declares the three documented fields',
)

const registered = []
mod.apply({ tools: { register: def => registered.push(def) } }, { maxResults: 5, defaultBudgetUsd: 0, preferLowCost: false })

assert.deepEqual(
  registered.map(tool => tool.name).sort(),
  ['model_compare', 'model_cost', 'model_recommend'],
  'all three documented tools register',
)
const VALID_ARGS = {
  model_recommend: { task: 'chat', needVision: false, budget: 0 },
  model_compare: { ids: ['gpt-4o', 'gpt-4o-mini'] },
  model_cost: { id: 'gpt-4o', tokensIn: 1000, tokensOut: 500 },
}

for (const tool of registered) {
  assert.ok(tool.description.length > 60, `${tool.name} has a model-facing description`)
  assert.ok(tool.parameters?.type === 'object', `${tool.name} compiles a parameter object schema`)
  assert.ok(Array.isArray(tool.parameters?.required) && tool.parameters.required.length > 0, `${tool.name} declares required parameters`)
  assert.equal(typeof tool.output?.render, 'function', `${tool.name} renders output`)
  assert.equal(typeof tool.execute, 'function', `${tool.name} executes`)
  // The registry fail-closes the concurrency probe on invalid arguments, so
  // check both halves: opt-in with a valid call, exclusive with a bogus one.
  assert.equal(tool.isConcurrencySafe(VALID_ARGS[tool.name]), true, `${tool.name} opts into parallel dispatch`)
  assert.equal(tool.isConcurrencySafe({ bogus: 1 }), false, `${tool.name} fails closed on invalid arguments`)
}

const byName = new Map(registered.map(tool => [tool.name, tool]))
const recommend = await byName.get('model_recommend').execute({ task: 'summarize', needVision: false, budget: 0 })
assert.equal(recommend.ok, true, 'model_recommend returns candidates')
assert.ok(recommend.ranked.length > 0 && recommend.ranked[0].id === 'gemini-flash', 'model_recommend ranks deterministically')

const compare = await byName.get('model_compare').execute({ ids: ['gpt-4o', 'gpt-4o-mini'] })
assert.equal(compare.ok, true, 'model_compare resolves known ids')
assert.equal(compare.winners.lowestCost, 'gpt-4o-mini', 'model_compare picks the cheaper winner')

const cost = await byName.get('model_cost').execute({ id: 'gpt-4o', tokensIn: 1000, tokensOut: 500 })
assert.equal(cost.ok, true, 'model_cost prices a known model')
assert.equal(Math.round(cost.totalCostUsd * 1e6), 7500, 'model_cost totals $0.0075')

const blocks = byName.get('model_cost').output.render({ id: 'gpt-4o', tokensIn: 1000, tokensOut: 500 }, cost)
assert.equal(blocks[0].type, 'text', 'render emits text blocks')

console.log('load-smoke: ok —', registered.length, 'tools registered from built artifact')
