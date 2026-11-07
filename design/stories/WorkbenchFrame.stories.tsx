import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { FolderOpen, Maximize2, Minimize2, X } from 'lucide-react';
import { WorkbenchFrame, useNarrow } from '../../src/web/patterns/workbench-frame.tsx';
import { ExampleHeader, ExampleSidebar } from './compositions.tsx';
import { conversations } from './fixtures.tsx';
import { phone, useReadout } from './catalog.tsx';

type Args = { collapsed: boolean; navigationOpen: boolean; panel: 'none' | 'open' | 'expanded' };

/**
 * The frame owns the viewport only: sidebar column (a focus-trapped drawer below 760px), the main column with
 * its header, and the side panel. Placeholder content marks each region.
 */
function FrameDemo({ collapsed: initialCollapsed, navigationOpen: initialOpen, panel: initialPanel }: Args) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [navigation, setNavigation] = useState(initialOpen);
  const [panel, setPanel] = useState(initialPanel);
  const [selected, setSelected] = useState(conversations[0]!.id);
  const [readout, say] = useReadout();
  const narrow = useNarrow();
  const conversation = conversations.find(item => item.id === selected);
  return <WorkbenchFrame collapsed={collapsed} onCollapsedChange={setCollapsed} navigationOpen={navigation} onNavigationChange={setNavigation}
    sidebar={<ExampleSidebar narrow={narrow} selected={selected} onSelect={id => { setSelected(id); setNavigation(false); }}
      onCollapse={() => setCollapsed(true)} onClose={() => setNavigation(false)} onAction={say}/>}
    header={<ExampleHeader conversation={conversation} onAction={say} extraActions={panel === 'none' &&
      <button type="button" className="text-button" onClick={() => setPanel('open')}><FolderOpen size={14}/>打开侧面板</button>}/>}
    panel={panel !== 'none' && <aside className="workspace-reader" aria-label="侧面板">
      <div className="workspace-reader-bar"><strong style={{ flex: 1, paddingLeft: 8 }}>侧面板（文件阅读器或子 Agent）</strong>
        <button type="button" className="reader-icon" aria-label={panel === 'expanded' ? '还原宽度' : '展开到整栏'} onClick={() => setPanel(panel === 'expanded' ? 'open' : 'expanded')}>
          {panel === 'expanded' ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
        <button type="button" className="reader-icon" aria-label="关闭侧面板" onClick={() => setPanel('none')}><X size={17}/></button></div>
      <div className="workspace-reader-content" style={{ padding: 24 }}><p className="quiet">面板从右侧滑入，覆盖主栏但不覆盖侧栏；展开后占满主栏。手机上它是全屏页面。</p></div>
    </aside>}
    panelExpanded={panel === 'expanded'}>
    <div className="message-scroll"><div className="message-column">
      <p className="quiet">主栏：页头之下是滚动的对话区，底部是输入区，两者共用 720px 的阅读宽度。</p>
      <p className="quiet" style={{ marginTop: 12 }}>桌面上用页头左侧按钮或 {'⌘/Ctrl + \\'} 收起侧栏；手机上点左上角打开导航抽屉，抽屉内 Esc 或点遮罩关闭。</p>
      {readout}
    </div></div>
  </WorkbenchFrame>;
}

const meta = {
  title: '模式/工作台框架',
  component: FrameDemo,
  args: { collapsed: false, navigationOpen: false, panel: 'none' },
  argTypes: { panel: { control: 'inline-radio', options: ['none', 'open', 'expanded'] } },
  render: args => <FrameDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof FrameDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = { name: '桌面' };
export const Collapsed: Story = { name: '侧栏收起', args: { collapsed: true } };
export const WithPanel: Story = { name: '侧面板', args: { panel: 'open' } };
export const PanelExpanded: Story = { name: '侧面板 · 展开', args: { panel: 'expanded' } };
export const Phone: Story = { name: '手机', globals: phone };
export const PhoneDrawer: Story = { name: '手机 · 导航抽屉', args: { navigationOpen: true }, globals: phone };
export const PhonePanel: Story = { name: '手机 · 侧面板', args: { panel: 'open' }, globals: phone };
