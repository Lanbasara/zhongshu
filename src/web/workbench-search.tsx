import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, FolderOpen, FolderPlus, HardDrive, PanelLeft, Puzzle, Settings, SquarePen } from 'lucide-react';
import { attentionSchema, conversationListSchema, type Conversation, type WorkbenchConfiguration } from '../shared/workbench.ts';
import { request } from './workbench-client.ts';
import { CommandPalette, type PaletteItem } from './patterns/command-palette.tsx';
import { conversationStatus } from './conversation-status.ts';
import { modifierKey } from './ui/controls.tsx';
import type { SettingsTab } from './settings-view.tsx';

/** Conversations needing attention and the unread count, shared with the other device through the server. */
export function useAttention(revision: number, report: (reason: unknown) => void) {
  const [value, setValue] = useState<{ unread: number; conversations: Conversation[] }>();
  const serial = useRef(0);
  const reportRef = useRef(report); reportRef.current = report;
  useEffect(() => {
    const controller = new AbortController(); const current = ++serial.current;
    const timer = setTimeout(() => {
      void request('/attention', attentionSchema, { signal: controller.signal }).then(result => { if (current === serial.current) setValue(result); })
        .catch(reason => { if (!controller.signal.aborted && reason?.status === 401) reportRef.current(reason); });
    }, value ? 120 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  return value;
}

export type SearchActions = {
  open(id: string): void; draft(workspaceId?: string): void; files(): void; archive(): void; settings(tab?: SettingsTab): void;
  toggleSidebar?: () => void; addWorkspace?: () => void;
};

/** Search and jump: conversations by title, workspaces and actions. Empty input lists what needs attention first. */
export function WorkbenchSearch({ open, onOpenChange, configuration, attention, actions, csrf }: {
  open: boolean; onOpenChange(open: boolean): void; configuration?: WorkbenchConfiguration; attention?: Conversation[]; actions: SearchActions; csrf: string;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ term: string; conversations: Conversation[] }>();
  const [failed, setFailed] = useState(false);
  const [recent, setRecent] = useState<Conversation[]>();
  const term = query.trim();
  useEffect(() => { if (!open) { setQuery(''); setFound(undefined); setFailed(false); } }, [open]);
  // Recent conversations make the empty palette a quick switcher between parallel work.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void request('/conversation-search', conversationListSchema, { csrf, signal: controller.signal, body: {} })
      .then(result => setRecent(result.conversations)).catch(() => {});
    return () => controller.abort();
  }, [open, csrf]);
  useEffect(() => {
    if (!open || !term) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void request('/conversation-search', conversationListSchema, { csrf, signal: controller.signal, body: { title: term } })
        .then(result => { setFound({ term, conversations: result.conversations }); setFailed(false); })
        .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, term, csrf]);
  const items = useMemo(() => {
    const lower = term.toLocaleLowerCase();
    const match = (text: string) => !lower || text.toLocaleLowerCase().includes(lower);
    const label = (id: string) => configuration?.workspaces.find(w => w.id === id)?.label ?? configuration?.removedWorkspaces?.find(w => w.id === id)?.label ?? '未登记工作区';
    const flagged = new Set((attention ?? []).map(conversation => conversation.id));
    const conversations = term ? (found?.term === term ? found.conversations : []).slice(0, 12)
      : [...(attention ?? []), ...(recent ?? []).filter(conversation => !flagged.has(conversation.id))].slice(0, 8);
    const result: PaletteItem[] = conversations.map(conversation => {
      const { status, label: statusLabel } = conversationStatus(conversation);
      return { id: `c:${conversation.id}`, group: term ? '对话' : flagged.has(conversation.id) ? '需要关注' : '最近', title: conversation.title, detail: label(conversation.workspaceId), status, statusLabel, run: () => actions.open(conversation.id) };
    });
    // A workspace is found by its display name or its directory name, so a rename does not hide it.
    for (const workspace of configuration?.workspaces ?? []) if (term && (match(workspace.label) || (!!workspace.directoryName && match(workspace.directoryName))))
      result.push({ id: `w:${workspace.id}`, group: '工作区', title: workspace.label, detail: '在这里新建对话', icon: <FolderOpen size={15}/>, run: () => actions.draft(workspace.id) });
    const commands: (Omit<PaletteItem, 'group'> & { keywords?: string })[] = [
      { id: 'a:new', title: '新对话', icon: <SquarePen size={15}/>, run: () => actions.draft() },
      { id: 'a:files', title: '工作区文件', icon: <FolderOpen size={15}/>, run: actions.files, keywords: 'files reader' },
      { id: 'a:archive', title: '已归档', icon: <Archive size={15}/>, run: actions.archive, keywords: 'archive' },
      { id: 'a:settings', title: '设置', icon: <Settings size={15}/>, run: () => actions.settings(), keywords: 'settings' },
      { id: 'a:workspaces', title: '管理工作区', icon: <FolderPlus size={15}/>, run: () => actions.settings('workspaces'), keywords: 'workspace' },
      { id: 'a:plugins', title: '插件', icon: <Puzzle size={15}/>, run: () => actions.settings('plugins'), keywords: 'plugins' },
      { id: 'a:storage', title: '存储', icon: <HardDrive size={15}/>, run: () => actions.settings('storage'), keywords: 'storage' },
      ...(actions.toggleSidebar ? [{ id: 'a:sidebar', title: '收起或展开侧栏', icon: <PanelLeft size={15}/>, shortcut: [modifierKey, '\\'], run: actions.toggleSidebar, keywords: 'sidebar' }] : []),
    ];
    for (const command of commands) if (match(command.title) || (command.keywords && match(command.keywords))) {
      const { keywords: _keywords, ...item } = command;
      result.push({ ...item, group: '操作' });
    }
    return result;
  }, [term, found, attention, recent, configuration, actions]);
  const status = failed ? '暂时无法搜索对话，请稍后重试。' : term && found?.term !== term ? '正在搜索…' : undefined;
  return <CommandPalette open={open} onOpenChange={onOpenChange} query={query} onQuery={setQuery} items={items} status={status}/>;
}
