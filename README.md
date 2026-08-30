# dsh-model-router

> DeepSeek Harness 智能模型路由插件

## 功能

- 🧠 **智能推荐**: 根据任务类型自动推荐最佳模型
- 📋 **模型数据库**: 内置 11+ 主流模型能力/价格/速度数据
- ⚖️ **能力对比**: 多模型横向比较优缺点
- 💰 **成本估算**: 预估 API 调用费用
- 🎯 **任务分类**: 自动识别编码/推理/创作/翻译/视觉/对话任务

## 内置模型

| 提供商 | 模型 | 价格 (Input/1M) |
|--------|------|-----------------|
| DeepSeek | V3, R1 | $0.27, $0.55 |
| OpenAI | GPT-4o, GPT-4o Mini, o1 | $2.50, $0.15, $15.00 |
| Anthropic | Claude Sonnet 4, 3.5 Sonnet | $3.00 |
| Google | Gemini 2.5 Pro, 2.0 Flash | $1.25, $0.10 |
| Local | Qwen 2.5 72B, Llama 3.1 70B | 免费 |

## 工具

| 工具名 | 说明 |
|--------|------|
| `model_recommend` | 根据任务推荐最佳模型 |
| `model_list` | 列出所有模型 |
| `model_compare` | 对比多个模型 |
| `model_cost` | 估算调用成本 |

## 命令

- `/model recommend <task>` — 推荐模型
- `/model list [provider]` — 列出模型
- `/model compare <m1,m2>` — 对比模型
- `/model cost <model> <in> <out>` — 估算成本

## License

MIT
