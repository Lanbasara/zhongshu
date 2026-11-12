import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PluginLibrary } from '../../src/web/patterns/plugin-library.tsx';
import { phone, useReadout } from './catalog.tsx';

type Props = Parameters<typeof PluginLibrary>[0];
type View = NonNullable<Props['view']>;
type Entry = View['entries'][number];
type Harness = Props['harness'];

const day = 86_400;
const pack: Entry = {
  id: 'example-pack@example-market', name: '示例技能包', description: '一组用于整理与核对材料的示例技能。', source: '示例市场', sourceId: 'example-market',
  author: '示例作者', homepage: 'https://example.com/plugins/example-pack', version: '1.2.0', installed: false, enabled: false, actions: ['install'], application: 'unverified',
  releases: [
    { version: '1.2.0', installable: true, publishedAt: 1_767_225_600, repository: 'https://example.com/repo/example-pack', commit: '0123456789abcdef0123456789abcdef01234567', directory: 'plugins/example-pack' },
    { version: '1.1.0', installable: true, publishedAt: 1_767_225_600 - 30 * day },
    { version: '1.0.0', installable: false, publishedAt: 1_767_225_600 - 90 * day },
  ],
  skills: [{ name: '示例：整理', description: '把零散材料整理成结构清晰的笔记。' }, { name: '示例：核对', description: '逐条核对数字和出处。' }],
};
const entries: Entry[] = [
  pack,
  { id: 'example-format@other-market', name: '示例格式工具', description: '统一示例文档的标题、列表和表格格式。', source: '另一个示例市场', sourceId: 'other-market',
    version: '0.4.1', installed: true, enabled: true, actions: ['disable', 'remove'], application: 'applied' },
  { id: 'example-export@other-market', name: '示例导出工具', description: '把示例笔记导出为其他格式。', source: '另一个示例市场', sourceId: 'other-market',
    version: '2.0.0', installed: true, enabled: false, actions: ['enable', 'remove'], application: 'unverified' },
  { id: 'builtin-example', name: '内置示例组件', description: '随原生 Host 提供，不能卸载。', source: '原生内置', version: null, installed: true, enabled: true, system: true, actions: [], application: 'applied' },
];
const sources: NonNullable<View['sources']> = [
  { id: 'example-market', name: '示例市场', url: 'https://example.com/marketplace', removable: false },
  { id: 'other-market', name: '另一个示例市场', url: 'https://example.org/market/index.json', removable: true },
];

type Scenario = 'library' | 'empty' | 'loading' | 'unconfigured' | 'offline' | 'applying' | 'restart-required' | 'unknown' | 'failed' | 'error' | 'uncertain' | 'busy' | 'source-unavailable';
type Args = { scenario: Scenario; sourceError: string };

function initialView(scenario: Scenario): View | undefined {
  if (scenario === 'loading') return undefined;
  if (scenario === 'empty') return { availability: 'available', entries: [], sources: [], operation: null };
  if (scenario === 'unconfigured' || scenario === 'offline') return { availability: scenario, entries: [], sources: scenario === 'offline' ? sources : [], operation: null };
  const operation = ['applying', 'restart-required', 'unknown', 'failed'].includes(scenario)
    ? { pluginId: pack.id, action: 'install' as const, status: scenario as 'applying' | 'restart-required' | 'unknown' | 'failed' } : null;
  return { availability: 'available', entries, operation, sources: scenario === 'source-unavailable' ? sources.map(source => source.id === 'other-market' ? { ...source, unavailable: true } : source) : sources };
}

/** The library with local, fake state for plugin and source changes. */
function PluginDemo({ scenario, sourceError }: Args) {
  const [harness, setHarness] = useState<Harness>('codex');
  const [views, setViews] = useState<Record<Harness, View | undefined>>(() => ({ codex: initialView(scenario), dsh: initialView(scenario) }));
  const [readout, say] = useReadout();
  const update = (change: (view: View) => View) => setViews(current => ({ ...current, [harness]: current[harness] && change(current[harness]) }));
  return <div className="settings"><div className="settings-scroll"><div className="settings-column"><section className="settings-section">
    <PluginLibrary key={harness} harness={harness} onHarness={setHarness} view={views[harness]}
      error={scenario === 'error' ? '示例：暂时无法读取插件状态，请稍后重试。' : undefined} sourceError={sourceError || undefined}
      busy={scenario === 'busy'} uncertain={scenario === 'uncertain'}
      onRefresh={() => say('刷新插件状态')} onDetail={id => say(id ? `查看 ${id}` : '返回列表')} onRetry={() => say('核对同一操作')}
      onCheckUpdates={harness === 'codex' ? () => {
        say('检查更新');
        update(view => ({ ...view, updateCheck: { checked: 1, unavailable: 0 }, entries: view.entries.map(item =>
          item.id === 'example-format@other-market' && item.installed && item.version === '0.4.1'
            ? { ...item, update: { version: '0.5.0', revision: 'a'.repeat(40), commit: 'b'.repeat(40) },
              actions: item.enabled && !item.actions.includes('update') ? [...item.actions, 'update'] : item.actions }
            : item) }));
      } : undefined}
      onReconcile={() => { update(view => ({ ...view, operation: null })); say('核对原生结果'); }}
      onSource={async command => {
        say(command.action === 'add' ? `添加来源 ${command.source}` : `移除来源 ${command.id}`);
        if (sourceError) return false;
        update(view => command.action === 'add'
          ? { ...view, sources: [...(view.sources ?? []).filter(source => source.id !== 'added-market'), { id: 'added-market', name: '新增的示例市场', url: 'https://example.net/market', removable: true }] }
          : { ...view, sources: view.sources?.filter(source => source.id !== command.id), entries: view.entries.filter(entry => entry.sourceId !== command.id) });
        return true;
      }}
      onAction={(entry, action, version) => {
        say(`${action} ${entry.name}${version ? ` ${version}` : ''}`);
        update(view => ({ ...view, entries: view.entries.map(item => {
          if (item.id !== entry.id) return item;
          const installed = action !== 'remove';
          const enabled = installed && action !== 'disable';
          const availableUpdate = installed && action !== 'update' ? item.update : undefined;
          return { ...item, installed, enabled, version: action === 'update' ? item.update?.version ?? item.version : version ?? item.version,
            update: availableUpdate, application: enabled ? 'applied' : 'unverified',
            actions: installed ? [enabled ? 'disable' : 'enable', 'remove', ...(item.releases?.length ? ['install' as const] : []),
              ...(enabled && availableUpdate ? ['update' as const] : [])] : ['install'] };
        }) }));
      }}/>
    {readout}
  </section></div></div></div>;
}

const meta = {
  title: '模式/插件库',
  component: PluginDemo,
  args: { scenario: 'library', sourceError: '' },
  argTypes: { scenario: { control: 'select', options: ['library', 'empty', 'loading', 'unconfigured', 'offline', 'applying', 'restart-required', 'unknown', 'failed', 'error', 'uncertain', 'busy', 'source-unavailable'] } },
  render: args => <PluginDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof PluginDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Library: Story = { name: '浏览与管理' };
export const Loading: Story = { name: '正在读取', args: { scenario: 'loading' } };
export const FirstSource: Story = { name: '还没有市场来源', args: { scenario: 'empty' } };
export const Unconfigured: Story = { name: '此环境尚未接通', args: { scenario: 'unconfigured' } };
export const Offline: Story = { name: '暂时无法读取市场', args: { scenario: 'offline' } };
export const Applying: Story = { name: '正在处理（锁定）', args: { scenario: 'applying' } };
export const RestartRequired: Story = { name: '等待原生 Host 重启', args: { scenario: 'restart-required' } };
export const ResultUnknown: Story = { name: '结果待核实', args: { scenario: 'unknown' } };
export const ActionFailed: Story = { name: '原生操作失败', args: { scenario: 'failed' } };
export const ReadError: Story = { name: '读取出错', args: { scenario: 'error' } };
export const Uncertain: Story = { name: '请求结果不确定', args: { scenario: 'uncertain' } };
export const SourceUnavailable: Story = { name: '某个来源不可用', args: { scenario: 'source-unavailable' } };
export const SourceError: Story = { name: '添加来源失败', args: { sourceError: '示例：这个地址不是公开的市场索引。' } };
export const Phone: Story = { name: '手机', globals: phone };
