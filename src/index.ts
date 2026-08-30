/**
 * dsh-model-router — 智能模型路由
 *
 * 功能：
 * 1. 任务分析：根据任务类型推荐最佳模型
 * 2. 模型数据库：内置主流模型能力/价格/速度数据
 * 3. 成本估算：预估 API 调用费用
 * 4. 性能对比：多模型能力横向比较
 * 5. 路由建议：根据需求（速度/质量/成本）给出推荐
 * 6. 使用统计：追踪模型调用历史
 */

import { z } from 'zod';

export const name = 'dsh-model-router';
export const inject = ['settings', 'tools', 'commands'];

const configSchema = z.object({
  enabled: z.boolean().default(true),
  preferFree: z.boolean().default(false),
  maxCostPerTask: z.number().min(0).default(0.1),
  defaultProvider: z.enum(['deepseek', 'openai', 'anthropic', 'google', 'auto']).default('auto'),
});

type Config = z.infer<typeof configSchema>;

// ==================== 模型数据库 ====================

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  family: string;
  contextWindow: number;
  maxOutput: number;
  inputPrice: number;   // per 1M tokens
  outputPrice: number;
  speed: 'fast' | 'medium' | 'slow';
  coding: number;       // 1-10
  reasoning: number;
  creative: number;
  multilingual: number;
  vision: boolean;
  functionCalling: boolean;
  openSource: boolean;
}

const MODELS: ModelInfo[] = [
  // DeepSeek
  { id: 'deepseek-chat', name: 'DeepSeek-V3', provider: 'deepseek', family: 'deepseek-v3', contextWindow: 65536, maxOutput: 8192, inputPrice: 0.27, outputPrice: 1.10, speed: 'fast', coding: 8, reasoning: 8, creative: 7, multilingual: 8, vision: false, functionCalling: true, openSource: true },
  { id: 'deepseek-reasoner', name: 'DeepSeek-R1', provider: 'deepseek', family: 'deepseek-r1', contextWindow: 65536, maxOutput: 8192, inputPrice: 0.55, outputPrice: 2.19, speed: 'medium', coding: 9, reasoning: 10, creative: 7, multilingual: 8, vision: false, functionCalling: false, openSource: true },
  // OpenAI
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', family: 'gpt-4o', contextWindow: 128000, maxOutput: 16384, inputPrice: 2.50, outputPrice: 10.00, speed: 'medium', coding: 9, reasoning: 9, creative: 9, multilingual: 9, vision: true, functionCalling: true, openSource: false },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', family: 'gpt-4o-mini', contextWindow: 128000, maxOutput: 16384, inputPrice: 0.15, outputPrice: 0.60, speed: 'fast', coding: 7, reasoning: 7, creative: 7, multilingual: 8, vision: true, functionCalling: true, openSource: false },
  { id: 'o1', name: 'o1', provider: 'openai', family: 'o1', contextWindow: 200000, maxOutput: 100000, inputPrice: 15.00, outputPrice: 60.00, speed: 'slow', coding: 10, reasoning: 10, creative: 8, multilingual: 9, vision: true, functionCalling: false, openSource: false },
  // Anthropic
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', family: 'claude-4', contextWindow: 200000, maxOutput: 64000, inputPrice: 3.00, outputPrice: 15.00, speed: 'medium', coding: 9, reasoning: 9, creative: 9, multilingual: 9, vision: true, functionCalling: true, openSource: false },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic', family: 'claude-3.5', contextWindow: 200000, maxOutput: 8192, inputPrice: 3.00, outputPrice: 15.00, speed: 'medium', coding: 9, reasoning: 8, creative: 9, multilingual: 9, vision: true, functionCalling: true, openSource: false },
  // Google
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', family: 'gemini-2.5', contextWindow: 1000000, maxOutput: 65536, inputPrice: 1.25, outputPrice: 10.00, speed: 'medium', coding: 9, reasoning: 9, creative: 8, multilingual: 9, vision: true, functionCalling: true, openSource: false },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', family: 'gemini-2.0', contextWindow: 1000000, maxOutput: 8192, inputPrice: 0.10, outputPrice: 0.40, speed: 'fast', coding: 7, reasoning: 7, creative: 7, multilingual: 8, vision: true, functionCalling: true, openSource: false },
  // 本地/开源
  { id: 'qwen-2.5-72b', name: 'Qwen 2.5 72B', provider: 'local', family: 'qwen-2.5', contextWindow: 131072, maxOutput: 8192, inputPrice: 0, outputPrice: 0, speed: 'fast', coding: 8, reasoning: 8, creative: 7, multilingual: 8, vision: false, functionCalling: false, openSource: true },
  { id: 'llama-3.1-70b', name: 'Llama 3.1 70B', provider: 'local', family: 'llama-3.1', contextWindow: 131072, maxOutput: 4096, inputPrice: 0, outputPrice: 0, speed: 'fast', coding: 7, reasoning: 7, creative: 7, multilingual: 6, vision: false, functionCalling: false, openSource: true },
];

// ==================== 任务分类 ====================

type TaskType = 'coding' | 'reasoning' | 'creative' | 'translation' | 'analysis' | 'chat' | 'vision' | 'function_call';

function classifyTask(description: string): TaskType {
  const lower = description.toLowerCase();
  if (/代码|编程|debug|fix|refactor|test|代码审查|code|implement|bug|修复/.test(lower)) return 'coding';
  if (/推理|逻辑|数学|计算|分析|证明|分析问题|reason|logic|math/.test(lower)) return 'reasoning';
  if (/写作|创作|文章|故事|诗|文案|创意|creative|write|story|blog/.test(lower)) return 'creative';
  if (/翻译|translate|多语言|语言转换/.test(lower)) return 'translation';
  if (/分析|总结|摘要|summarize|analyze|数据|报告/.test(lower)) return 'analysis';
  if (/图片|图像|视觉|截图|photo|image|vision|ocr/.test(lower)) return 'vision';
  if (/工具|函数|api|调用|工具使用|function|tool|plugin/.test(lower)) return 'function_call';
  return 'chat';
}

// ==================== 模型推荐引擎 ====================

function scoreModel(model: ModelInfo, taskType: TaskType, config: Config): number {
  let score = 0;

  // 基础能力得分
  switch (taskType) {
    case 'coding': score = model.coding * 10; break;
    case 'reasoning': score = model.reasoning * 10; break;
    case 'creative': score = model.creative * 10; break;
    case 'translation': score = model.multilingual * 10; break;
    case 'analysis': score = (model.reasoning + model.coding) * 5; break;
    case 'vision': score = model.vision ? 90 : 0; break;
    case 'function_call': score = model.functionCalling ? 90 : 10; break;
    case 'chat': score = (model.coding + model.reasoning + model.creative) * 3; break;
  }

  // 速度加分
  if (model.speed === 'fast') score += 10;
  else if (model.speed === 'medium') score += 5;

  // 成本惩罚
  if (config.preferFree && model.inputPrice === 0) score += 20;
  if (model.inputPrice > config.maxCostPerTask * 1000) score -= 15;

  // 上下文窗口
  if (model.contextWindow >= 100000) score += 5;

  // 开源加分
  if (model.openSource) score += 3;

  return score;
}

function recommendModels(taskDescription: string, config: Config): { model: ModelInfo; score: number; reason: string }[] {
  const taskType = classifyTask(taskDescription);

  const scored = MODELS.map(model => ({
    model,
    score: scoreModel(model, taskType, config),
    reason: getRecommendationReason(model, taskType),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

function getRecommendationReason(model: ModelInfo, taskType: TaskType): string {
  const reasons: string[] = [];
  if (model.vision && taskType === 'vision') reasons.push('支持视觉理解');
  if (model.functionCalling && taskType === 'function_call') reasons.push('支持函数调用');
  if (model.speed === 'fast') reasons.push('响应速度快');
  if (model.inputPrice === 0) reasons.push('免费/开源');
  if (model.contextWindow >= 100000) reasons.push('大上下文窗口');
  if (model.coding >= 9) reasons.push('编码能力顶尖');
  if (model.reasoning >= 9) reasons.push('推理能力顶尖');
  if (model.openSource) reasons.push('开源模型');
  return reasons.join('、') || '综合表现良好';
}

// ==================== 成本估算 ====================

function estimateCost(model: ModelInfo, inputTokens: number, outputTokens: number): { inputCost: number; outputCost: number; totalCost: number; formatted: string } {
  const inputCost = (inputTokens / 1_000_000) * model.inputPrice;
  const outputCost = (outputTokens / 1_000_000) * model.outputPrice;
  const totalCost = inputCost + outputCost;
  return {
    inputCost,
    outputCost,
    totalCost,
    formatted: totalCost === 0 ? '免费' : `$${totalCost.toFixed(6)}`,
  };
}

// ==================== 对比分析 ====================

function compareModels(modelIds: string[]): { model: ModelInfo; strengths: string[]; weaknesses: string[] }[] {
  return modelIds.map(id => {
    const model = MODELS.find(m => m.id === id || m.name.toLowerCase().includes(id.toLowerCase()));
    if (!model) return null;

    const strengths: string[] = [];
    const weaknesses: string[] = [];

    if (model.coding >= 9) strengths.push('编码能力顶尖');
    else if (model.coding <= 6) weaknesses.push('编码能力较弱');
    if (model.reasoning >= 9) strengths.push('推理能力顶尖');
    else if (model.reasoning <= 6) weaknesses.push('推理能力较弱');
    if (model.creative >= 9) strengths.push('创意写作出色');
    if (model.vision) strengths.push('支持视觉理解');
    if (model.functionCalling) strengths.push('支持函数调用');
    if (model.speed === 'fast') strengths.push('响应速度快');
    if (model.speed === 'slow') weaknesses.push('响应速度较慢');
    if (model.inputPrice === 0) strengths.push('免费使用');
    if (model.inputPrice > 10) weaknesses.push('价格较高');
    if (model.openSource) strengths.push('开源可部署');

    return { model, strengths, weaknesses };
  }).filter(Boolean) as any;
}

// ==================== 模型列表 ====================

function listAllModels(): ModelInfo[] {
  return MODELS;
}

function getModelById(id: string): ModelInfo | undefined {
  return MODELS.find(m => m.id === id || m.name.toLowerCase().includes(id.toLowerCase()));
}

// ==================== 插件入口 ====================

export function apply(ctx: any, config: Config) {
  if (!config.enabled) return;

  // model_recommend — 推荐模型
  ctx.effect(() => ctx.tools.register({
    name: 'model_recommend',
    description: '根据任务描述智能推荐最佳 AI 模型。分析任务类型，从速度、质量、成本多维度评分排序。',
    parameters: {
      task: { type: 'string', description: '任务描述（如：帮我修复一个 React 的类型错误、写一篇技术博客）' },
      prefer: { type: 'string', description: '偏好：speed（速度优先）| quality（质量优先）| cost（成本优先）' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const results = value as { model: ModelInfo; score: number; reason: string }[];
        if (results.length === 0) return [{ type: 'text', text: '没有找到合适的模型' }];
        const lines = ['## 🤖 推荐模型'];
        for (const [i, r] of results.entries()) {
          const icon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
          const price = r.model.inputPrice === 0 ? '免费' : `$${r.model.inputPrice}/1M in`;
          lines.push(`${icon} **${r.model.name}** (${r.model.provider}) — 评分: ${r.score}`);
          lines.push(`  价格: ${price} | 速度: ${r.model.speed} | 上下文: ${(r.model.contextWindow / 1000).toFixed(0)}K`);
          lines.push(`  推荐理由: ${r.reason}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: { task: string; prefer?: string }) {
      const cfg = { ...config };
      if (args.prefer === 'speed') cfg.preferFree = false;
      else if (args.prefer === 'cost') cfg.preferFree = true;
      return recommendModels(args.task, cfg);
    },
  }), 'dsh-model-router: recommend');

  // model_list — 列出所有模型
  ctx.effect(() => ctx.tools.register({
    name: 'model_list',
    description: '列出所有支持的 AI 模型及其能力、价格、速度信息。',
    parameters: {
      provider: { type: 'string', description: '筛选特定提供商（deepseek/openai/anthropic/google/local）' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const models = value as ModelInfo[];
        const lines = [`## 📋 模型列表 (${models.length})`];
        for (const m of models) {
          const price = m.inputPrice === 0 ? '免费' : `$${m.inputPrice}`;
          lines.push(`- **${m.name}** (${m.id}) — ${m.provider}`);
          lines.push(`  编码:${m.coding} 推理:${m.reasoning} 创意:${m.creative} 多语言:${m.multilingual}`);
          lines.push(`  价格: ${price} | 速度: ${m.speed} | 上下文: ${(m.contextWindow / 1000).toFixed(0)}K | 视觉: ${m.vision ? '✓' : '✗'}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: { provider?: string }) {
      if (args.provider) return MODELS.filter(m => m.provider === args.provider);
      return MODELS;
    },
  }), 'dsh-model-router: list');

  // model_compare — 模型对比
  ctx.effect(() => ctx.tools.register({
    name: 'model_compare',
    description: '对比多个模型的能力、优缺点、价格。',
    parameters: {
      models: { type: 'string', description: '模型 ID，逗号分隔（如 gpt-4o,claude-sonnet-4,deepseek-chat）' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const results = value as { model: ModelInfo; strengths: string[]; weaknesses: string[] }[];
        if (results.length === 0) return [{ type: 'text', text: '未找到指定模型' }];
        const lines = ['## ⚖️ 模型对比'];
        for (const r of results) {
          lines.push(`### ${r.model.name} (${r.model.provider})`);
          lines.push(`编码: ${r.model.coding}/10 | 推理: ${r.model.reasoning}/10 | 创意: ${r.model.creative}/10`);
          lines.push(`价格: $${r.model.inputPrice}/$${r.model.outputPrice} | 速度: ${r.model.speed} | 上下文: ${(r.model.contextWindow / 1000).toFixed(0)}K`);
          if (r.strengths.length) lines.push(`优势: ${r.strengths.join('、')}`);
          if (r.weaknesses.length) lines.push(`劣势: ${r.weaknesses.join('、')}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: { models: string }) {
      const ids = args.models.split(',').map(s => s.trim());
      return compareModels(ids);
    },
  }), 'dsh-model-router: compare');

  // model_cost — 成本估算
  ctx.effect(() => ctx.tools.register({
    name: 'model_cost',
    description: '估算特定模型的 API 调用成本。',
    parameters: {
      model: { type: 'string', description: '模型 ID 或名称' },
      input_tokens: { type: 'number', description: '预计输入 token 数' },
      output_tokens: { type: 'number', description: '预计输出 token 数' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const cost = value as any;
        return [{ type: 'text', text: `## 💰 成本估算\n模型: ${cost.model?.name || '未知'}\n输入: $${cost.inputCost?.toFixed(6)} | 输出: $${cost.outputCost?.toFixed(6)}\n总计: **${cost.formatted}**` }];
      },
    },
    async execute(args: { model: string; input_tokens: number; output_tokens: number }) {
      const model = getModelById(args.model);
      if (!model) throw new Error(`未找到模型: ${args.model}`);
      return { ...estimateCost(model, args.input_tokens, args.output_tokens), model };
    },
  }), 'dsh-model-router: cost');

  // slash 命令 /model
  ctx.effect(() => ctx.commands.register({
    name: 'model',
    description: '智能模型路由',
    input: { hint: 'recommend <task> | list [provider] | compare <model1,model2> | cost <model> <tokens>' },
    async handler(invocation: any) {
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { kind: 'text', text: '用法: /model recommend <task> | list | compare <models> | cost <model> <in_tokens> <out_tokens>' };
      const cmd = parts[0];
      switch (cmd) {
        case 'recommend': {
          const task = parts.slice(1).join(' ');
          if (!task) return { kind: 'text', text: '请描述任务' };
          const results = recommendModels(task, config);
          return { kind: 'text', text: results.map((r, i) => `${i + 1}. ${r.model.name} (${r.model.provider}) — ${r.reason}`).join('\n') };
        }
        case 'list': {
          const models = parts[1] ? MODELS.filter(m => m.provider === parts[1]) : MODELS;
          return { kind: 'text', text: models.map(m => `${m.name} (${m.provider}) — 编码:${m.coding} 推理:${m.reasoning}`).join('\n') };
        }
        case 'compare': {
          const ids = parts[1]?.split(',') || [];
          const results = compareModels(ids);
          return { kind: 'text', text: results.map(r => `${r.model.name}: ${r.strengths.join('、')}`).join('\n') };
        }
        case 'cost': {
          const model = getModelById(parts[1] || '');
          if (!model) return { kind: 'text', text: `未找到模型: ${parts[1]}` };
          const cost = estimateCost(model, Number(parts[2]) || 0, Number(parts[3]) || 0);
          return { kind: 'text', text: `${model.name}: ${cost.formatted}` };
        }
        default: return { kind: 'text', text: `未知命令: ${cmd}` };
      }
    },
  }), 'dsh-model-router: command');

  // 设置注册
  ctx.inject(['settings'], (sctx: any) => {
    const { settingsNamespace } = require('@deepseek-ai/dsh-settings');
    sctx.settings.register(settingsNamespace('model-router'), configSchema, { base: config, expose: true, applies: 'live' });
  });
}
