import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import type { Conversation, WorkbenchConfiguration } from '../shared/workbench.ts';
import { ConversationResults } from './conversation-navigation.tsx';

/** Archived conversations, searchable by title; restoring happens from each conversation's menu. */
export function ArchiveView({ configuration, revision, csrf, report, choose, manage, selected }: {
  configuration?: WorkbenchConfiguration; revision: number; csrf: string; report(reason: unknown): void;
  choose(id: string): void; manage(conversation: Conversation): void; selected?: string;
}) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const timer = setTimeout(() => setTerm(search.trim()), 180); return () => clearTimeout(timer); }, [search]);
  const workspaceLabel = (id: string) => configuration?.workspaces.find(workspace => workspace.id === id)?.label ??
    configuration?.removedWorkspaces?.find(workspace => workspace.id === id)?.label ?? '未登记工作区';
  return <div className="archive">
    <div className="archive-column">
      <p className="settings-lead">归档的对话不在侧栏显示，历史仍可阅读。打开后可从「⋯」恢复。</p>
      <label className="archive-search"><Search size={15}/><input type="search" aria-label="搜索已归档对话" placeholder="搜索已归档对话" maxLength={200}
        value={search} onChange={event => setSearch(event.target.value)}/></label>
      <div className="archive-list">
        {search.trim() && term !== search.trim() ? <p className="navigation-empty">正在搜索…</p> :
          <ConversationResults key={term} query={{ archived: true, ...(term ? { title: term } : {}) }} revision={revision} csrf={csrf} report={report}
            rows={{ selected, choose, manage }} workspaceLabel={workspaceLabel} empty={term ? '没有匹配的已归档对话' : '还没有归档的对话'}/>}
      </div>
    </div>
  </div>;
}
