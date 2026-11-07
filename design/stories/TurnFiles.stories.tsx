import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TurnFiles } from '../../src/web/patterns/turn-files.tsx';
import { exampleFiles } from './fixtures.tsx';
import { phone, useReadout } from './catalog.tsx';

type Args = { count: number; limited: boolean; unavailable: 'none' | 'one' | 'all'; active: boolean };

/** The list shows three files, then a toggle for the rest. Paths are display data; opening belongs to the workbench. */
function TurnFilesDemo({ count, limited, unavailable, active }: Args) {
  const [activePath, setActivePath] = useState(active ? exampleFiles[0] : undefined);
  const [readout, say] = useReadout();
  const files = exampleFiles.slice(0, count).map((path, index) => ({ path, unavailable: unavailable === 'all' || (unavailable === 'one' && index === 1) }));
  return <div className="catalog-column">
    <p className="catalog-muted" style={{ marginBottom: 12 }}>一轮结束后列出它改过的文件，点一行在侧面阅读器中打开（当前打开的一行高亮）。工作区被移除或文件已不存在时，行变为不可点并说明原因。</p>
    <TurnFiles files={files} limited={limited} activePath={activePath} onOpen={path => { setActivePath(path); say(`在阅读器中打开 ${path}`); }}/>
    {readout}
  </div>;
}

const meta = {
  title: '模式/本轮文件',
  component: TurnFilesDemo,
  args: { count: 3, limited: false, unavailable: 'none', active: false },
  argTypes: {
    count: { control: { type: 'range', min: 1, max: exampleFiles.length, step: 1 } },
    unavailable: { control: 'inline-radio', options: ['none', 'one', 'all'] },
  },
  render: args => <TurnFilesDemo key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof TurnFilesDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = { name: '单个文件', args: { count: 1 } };
export const Few: Story = { name: '三个以内' };
export const Many: Story = { name: '超过三个 · 可展开', args: { count: exampleFiles.length } };
export const Limited: Story = { name: '只显示前若干个', args: { count: exampleFiles.length, limited: true } };
export const Unavailable: Story = { name: '部分文件不可用', args: { unavailable: 'one' } };
export const WorkspaceRemoved: Story = { name: '工作区已移除', args: { unavailable: 'all' } };
export const Active: Story = { name: '当前打开', args: { active: true } };
export const Phone: Story = { name: '手机', args: { count: exampleFiles.length }, globals: phone };
