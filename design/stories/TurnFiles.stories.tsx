import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { FolderOpen, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { Transcript } from '../../src/web/conversation-content.tsx';
import { TurnFiles, type TurnFile } from '../../src/web/patterns/turn-files.tsx';
import { WorkbenchFrame } from '../../src/web/patterns/workbench-frame.tsx';
import { BrandMark } from '../../src/web/ui/controls.tsx';
import './turn-files-preview.css';

type DemoFile = TurnFile & { text?: string };

const files: readonly DemoFile[] = [
  { path: 'docs/release/release-checklist.md', text: '# 发布前检查清单\n\n1. 确认版本与负责人\n2. 完成预发布环境验证\n3. 复核回滚入口\n4. 记录发布结果' },
  { path: 'docs/release/rollback.md', text: '# 回滚步骤\n\n恢复上一个已验证的版本，随后核对服务和监控状态。' },
  { path: 'docs/index.md', text: '# 产品手册\n\n发布前检查清单 · 回滚步骤 · 交接说明' },
  { path: 'docs/release/handoff.md', text: '# 交接说明\n\n请在发布结束后记录验证结果。' },
  { path: 'docs/release/archive/international-release-verification-and-handoff.md', text: '# 跨区域发布验证\n\n发布后逐一确认各区域的版本。' },
];
const unavailable = { path: 'docs/archive/release-draft.md', unavailable: true };

function TurnFilesPreview({ entries }: { entries: readonly DemoFile[] }) {
  const [navigation, setNavigation] = useState(false);
  const [selected, setSelected] = useState<DemoFile>();
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width:759px)').matches);
  const origin = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const query = matchMedia('(max-width:759px)');
    const resize = () => setNarrow(query.matches);
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    if (selected && !narrow) closeButton.current?.focus({ preventScroll: true });
  }, [selected, narrow]);

  function restoreFocus() {
    const trigger = origin.current;
    if (trigger?.closest('[hidden]')) {
      trigger.closest('section')?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.focus();
    } else {
      trigger?.focus();
    }
  }
  function closeReader() {
    setSelected(undefined);
    if (!narrow) restoreFocus();
  }

  const readerContents = selected && <>
    <div className="workspace-reader-bar turn-files-preview-bar">
      <FolderOpen size={17} aria-hidden="true"/><span>工作区文件</span>
      <button ref={closeButton} className="reader-icon" type="button" aria-label="关闭文件阅读器"
        onClick={closeReader}><X size={17} aria-hidden="true"/></button>
    </div>
    <div className="workspace-reader-content turn-files-preview-content">
      <p className="turn-files-preview-caption">当前文件 · 模拟预览</p>
      <h2>{selected.path.split('/').at(-1)}</h2>
      <p className="turn-files-preview-path">{selected.path}</p>
      <pre>{selected.text}</pre>
    </div>
  </>;

  return <>
    <WorkbenchFrame navigationOpen={navigation} onNavigationChange={setNavigation}
      sidebar={<>
        <div className="workbench-brand"><BrandMark/><span>中书</span></div>
        <p className="nav-label">产品手册工作区</p>
        <div className="conversation-row"><button className="conversation-link selected" type="button"
          onClick={() => setNavigation(false)}><strong>整理发布手册</strong><span>示例对话</span></button></div>
      </>}
      header={<div className="conversation-heading"><h1>整理发布手册</h1><p>产品手册工作区 · Storybook 模拟数据</p></div>}
      reader={selected && !narrow && <aside className="workspace-reader" aria-label="工作区文件"
        onKeyDown={event => { if (event.key === 'Escape') closeReader(); }}>{readerContents}</aside>}>
      <div className="message-scroll"><div className="message-column">
        <Transcript conversation="turn-files-example" onQuote={() => {}} items={[
          { id: 'prompt', kind: 'user', text: '更新发布前检查清单，把重复的说明合并一下。', status: 'completed' },
          { id: 'edit', kind: 'tool', text: '整理发布前检查项', status: 'completed', tool: { name: '修改文件' } },
          { id: 'reply', kind: 'assistant', text: '已按发布顺序整理检查项，合并了重复的发布前验证步骤。', status: 'completed' },
        ]}/>
        <TurnFiles files={entries} activePath={selected?.path} onOpen={(path, trigger) => {
          origin.current = trigger;
          setSelected(entries.find(file => file.path === path));
        }}/>
      </div></div>
    </WorkbenchFrame>
    <Dialog.Root open={narrow && !!selected} onOpenChange={open => { if (!open) closeReader(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="turn-files-preview-scrim"/>
        <Dialog.Content className="workspace-reader turn-files-preview-sheet" aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
          <Dialog.Title className="sr-only">工作区文件</Dialog.Title>
          {readerContents}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

const meta = {
  id: 'turn-files',
  title: '产品模式/本轮文件',
  component: TurnFilesPreview,
  args: { entries: files },
} satisfies Meta<typeof TurnFilesPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = { name: '单文件', args: { entries: files.slice(0, 1) } };
export const Multiple: Story = { name: '多文件' };
export const Unavailable: Story = { name: '文件不可用', args: { entries: [...files.slice(0, 2), unavailable] } };
export const Narrow: Story = { name: '窄屏', globals: { viewport: { value: '390-740', isRotated: false } } };
