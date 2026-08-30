/**
 * dsh-model-router 客户端 — 设置卡片
 */
import React from 'react';
const NS = 'model-router';
const zh = { title: '模型路由', description: '智能推荐最佳 AI 模型', enabled: '启用插件', preferFree: '优先免费模型', maxCost: '单任务最大成本 ($)' };
const en = { title: 'Model Router', description: 'Smart AI model recommendation', enabled: 'Enable plugin', preferFree: 'Prefer free models', maxCost: 'Max cost per task ($)' };

export const inject = ['settingsScope', 'slots', 'locale'];

export function apply(ctx: any) {
  const t = ctx.locale?.bind(NS) || ((k: string) => (zh as any)[k] || k);
  ctx.effect?.(() => ctx.locale?.register?.(NS, { zh, en }), 'dsh-model-router: locale');
  ctx.effect?.(() => {
    ctx.slots?.inject?.('settings.plugin.item', function* () {
      yield ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({}) }, RouterCard);
    });
  }, 'dsh-model-router: settings card');
}

function RouterCard(props: any) {
  const { scope, t } = props;
  const [open, setOpen] = React.useState(false);
  return React.createElement('li', { className: 'dsh-router-card' },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', cursor: 'pointer' }, onClick: () => setOpen(!open) },
      React.createElement('div', null, React.createElement('strong', null, '🧠 ', t('title')), React.createElement('p', { style: { margin: '2px 0 0', fontSize: '12px', color: '#888' } }, t('description'))),
      React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, open ? '▲' : '▼')),
    open ? React.createElement('div', { style: { padding: '8px 0', borderTop: '1px solid #333' } },
      React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '8px' } },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('enabled') ?? true, onChange: (e: any) => scope?.set?.('enabled', e.target.checked) }),
        t('enabled')),
      React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('preferFree') ?? false, onChange: (e: any) => scope?.set?.('preferFree', e.target.checked) }),
        t('preferFree'))) : null);
}
