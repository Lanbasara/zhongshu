import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PluginEntry, PluginHarness, PluginView } from '../../src/shared/plugins.ts';
import { PluginLibrary } from '../../src/web/patterns/plugin-library.tsx';
import { WorkbenchFrame } from '../../src/web/patterns/workbench-frame.tsx';
import { BrandMark, Button } from '../../src/web/ui/controls.tsx';

const base: PluginEntry = {
  id: 'zhixing@zhixing', name: '知行', description: '可组合的工程技能与共享判断原则。', source: '知行市场',
  sourceId: 'zhixing', version: '0.3.4', installed: false, enabled: false, actions: ['install'], application: 'unverified',
};
const second: PluginEntry = {
  ...base, id: 'jianwei', name: '见微 Jianwei', description: '用数据、研究与复盘技能组织投资研究。', source: '见微市场', sourceId: 'jianwei',
  author: 'Lanbasara', version: '0.3.1', releases: [{ version: '0.3.1', installable: true }, { version: '0.3.0', installable: true }],
};

function Preview({ scenario }: { scenario: 'library' | 'empty' | 'waiting' }) {
  const [harness, setHarness] = useState<PluginHarness>('codex');
  const [navigation, setNavigation] = useState(false);
  const [views, setViews] = useState<Record<PluginHarness, PluginView>>(() => {
    const operation = scenario === 'waiting' ? { id: 'example', pluginId: base.id, action: 'install' as const, status: 'restart-required' as const } : null;
    const catalog: PluginView = {
      availability: 'available', operation,
      entries: scenario === 'empty' ? [] : [base],
      sources: scenario === 'empty' ? [] : [{ id: 'zhixing', name: '知行市场', url: 'https://github.com/example/zhixing-marketplace', removable: false }],
    };
    return { codex: catalog, dsh: { ...catalog, operation: null, entries: scenario === 'empty' ? [] : [{ ...base, id: 'zhixing' }] } };
  });
  const setView = (update: (value: PluginView) => PluginView) => setViews(previous => ({ ...previous, [harness]: update(previous[harness]) }));
  return <WorkbenchFrame navigationOpen={navigation} onNavigationChange={setNavigation}
    sidebar={<><div className="workbench-brand"><BrandMark/><span>中书</span></div><Button>新对话</Button>
      <div className="sidebar-bottom"><button className="sidebar-files" aria-current="page">插件管理</button></div></>}
    header={<div className="conversation-heading"><p>工作台 / 插件</p></div>}>
    <PluginLibrary key={harness} harness={harness} onHarness={setHarness} view={views[harness]} onRefresh={() => {}}
      onDetail={() => {}} onRetry={() => {}} onReconcile={() => setView(value => ({ ...value, operation: null }))}
      onSource={async command => {
        setView(value => command.action === 'add' ? {
          ...value, sources: [...(value.sources ?? []).filter(source => source.id !== 'jianwei'),
            { id: 'jianwei', name: '见微市场', url: command.source, removable: true }],
          entries: [...value.entries.filter(entry => entry.id !== second.id), harness === 'dsh' ? second : { ...second, releases: undefined }],
        } : { ...value, sources: value.sources?.filter(source => source.id !== command.id), entries: value.entries.filter(entry => entry.sourceId !== command.id) });
        return true;
      }}
      onAction={(entry, action, version) => setView(value => ({ ...value, entries: value.entries.map(item => {
        if (item.id !== entry.id) return item;
        const installed = action !== 'remove';
        const enabled = installed && action !== 'disable';
        return { ...item, installed, enabled, version: version ?? item.version,
          actions: installed ? [enabled ? 'disable' : 'enable', 'remove', ...(item.releases?.length ? ['install' as const] : [])] : ['install'],
          application: enabled ? 'applied' : 'unverified',
          skills: enabled && item.id === base.id ? [{ name: 'Align', description: '通过研究与讨论澄清目标和边界。' }] : undefined };
      }) }))}/>
  </WorkbenchFrame>;
}

const meta = { title: '工作台/插件管理', component: Preview, args: { scenario: 'library' } } satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BrowseAndManage: Story = { name: '浏览、添加与安装' };
export const FirstSource: Story = { name: '添加第一个市场', args: { scenario: 'empty' } };
export const WaitingForHost: Story = { name: '原生待重启', args: { scenario: 'waiting' } };
