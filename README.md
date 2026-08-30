# dsh-model-router

> DeepSeek Harness 智能模型路由

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ 功能特性

- 🧠 **智能推荐**: 根据任务类型自动推荐最佳模型（编码/推理/创作/翻译/视觉）
- 📋 **模型数据库**: 内置 11+ 主流模型（DeepSeek/OpenAI/Anthropic/Google/Local）
- ⚖️ **能力对比**: 多模型横向比较优缺点
- 💰 **成本估算**: 预估 API 调用费用
- 🎯 **任务分类**: 自动识别任务类型并匹配最优模型

## 📦 安装

```bash
npm install dsh-model-router
```

## 🛠️ 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `model_recommend` | 根据任务推荐最佳模型 | `task`(任务描述), `prefer`(偏好) |
| `model_list` | 列出所有模型 | `provider`(提供商筛选) |
| `model_compare` | 对比多个模型 | `models`(模型ID，逗号分隔) |
| `model_cost` | 估算调用成本 | `model`, `input_tokens`, `output_tokens` |

## 📋 命令

- `/model recommend <task>` — 推荐模型
- `/model list [provider]` — 列出模型
- `/model compare <m1,m2>` — 对比模型
- `/model cost <model> <in> <out>` — 估算成本

## 📄 License

MIT
