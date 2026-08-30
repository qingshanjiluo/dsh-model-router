import React from 'react';
import { createSettingsCard } from '@deepseek-ai/dsh-settings';

export default createSettingsCard({
  title: 'model-router',
  description: '智能模型路由',
  config: [
    { key: 'enabled', type: 'boolean', label: '启用插件', default: true },
    { key: 'preferFree', type: 'boolean', label: '优先免费模型', default: false },
    { key: 'maxCostPerTask', type: 'number', label: '每任务最大成本($)', default: 0.1 },
    { key: 'defaultProvider', type: 'select', label: '默认提供商', options: ['auto', 'deepseek', 'openai', 'anthropic', 'google'], default: 'auto' },
  ],
});
