import { useEffect, useState } from 'react';
import { ChevronRight, FolderPlus, MoreHorizontal, Pin, RotateCcw } from 'lucide-react';
import { versionSchema } from '../shared/http.ts';
import type { Conversation, WorkbenchConfiguration } from '../shared/workbench.ts';
import { ConversationResults } from './conversation-navigation.tsx';
import { Button, IconButton } from './ui/controls.tsx';
import { ConnectionStatus } from './patterns/sidebar.tsx';
import { PluginManagement } from './plugin-management.tsx';
import { NotificationSettingsPanel } from './notification-settings.tsx';
import { HarnessAccountsPanel, type Accounts } from './harness-accounts.tsx';
import { StoragePanel, type useStorage } from './storage-status.tsx';
import type { WorkspaceAction } from './workspace-management.tsx';

export type SettingsTab = 'workspaces' | 'plugins' | 'storage' | 'notifications' | 'account';
export const settingsTabs: { id: SettingsTab; label: string }[] = [
  { id: 'workspaces', label: '工作区' }, { id: 'plugins', label: '插件' }, { id: 'storage', label: '存储' }, { id: 'notifications', label: '通知' }, { id: 'account', label: '账户' },
];

/** Everything that configures the instance rather than a conversation lives here (decided 2026-11-07). */
export function SettingsView({ tab, onTab, configuration, workspaceAction, csrf, report, storage, connection, logout, busy, revision, choose, manage, accounts }: {
  tab: SettingsTab; onTab(tab: SettingsTab): void; configuration?: WorkbenchConfiguration; workspaceAction(action: WorkspaceAction): void;
  revision: number; choose(id: string): void; manage(conversation: Conversation): void;
  csrf: string; report(reason: unknown): void; storage: ReturnType<typeof useStorage>;
  connection: { text: string; state: 'online' | 'connecting' | 'offline' }; logout(): void; busy: boolean; accounts: Accounts;
}) {
  return <div className="settings">
    <div className="settings-tabs" role="tablist" aria-label="设置">
      {settingsTabs.map(item => <button key={item.id} type="button" role="tab" id={`settings-tab-${item.id}`} aria-selected={tab === item.id}
        aria-controls="settings-panel" onClick={() => onTab(item.id)}>{item.label}</button>)}
    </div>
    <div className="settings-scroll" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
      <div className="settings-column">
        {tab === 'workspaces' && <WorkspaceSettings configuration={configuration} workspaceAction={workspaceAction} results={{ revision, csrf, report, rows: { choose, manage } }}/>}
        {tab === 'plugins' && <section className="settings-section"><PluginManagement csrf={csrf} report={report}/></section>}
        {tab === 'storage' && <StoragePanel csrf={csrf} report={report} storage={storage}/>}
        {tab === 'notifications' && <NotificationSettingsPanel csrf={csrf} report={report}/>}
        {tab === 'account' && <><HarnessAccountsPanel csrf={csrf} accounts={accounts}/><AccountSettings connection={connection} logout={logout} busy={busy}/></>}
      </div>
    </div>
  </div>;
}

type ResultProps = { revision: number; csrf: string; report(reason: unknown): void; rows: { choose(id: string): void; manage(conversation: Conversation): void } };
function WorkspaceSettings({ configuration, workspaceAction, results }: { configuration?: WorkbenchConfiguration; workspaceAction(action: WorkspaceAction): void; results: ResultProps }) {
  const canAdd = !!configuration?.workspaceRoots?.length;
  const [opened, setOpened] = useState<string>();
  return <section className="settings-section" aria-labelledby="workspace-settings-title">
    <div className="settings-heading"><h2 id="workspace-settings-title">工作区</h2>
      {canAdd && <Button variant="primary" size="small" onClick={() => workspaceAction({ kind: 'add' })}><FolderPlus size={14}/>添加工作区</Button>}</div>
    <p className="settings-lead">工作区是 Agent 可以读写的目录。侧栏按工作区分组列出对话。</p>
    {!configuration ? <p className="settings-note" role="status">正在读取工作区…</p> : <>
      {configuration.workspaces.length ? <ul className="settings-list">
        {configuration.workspaces.map(workspace => <li key={workspace.id}>
          <div className="settings-item-text"><strong>{workspace.label}{workspace.pinned && <Pin size={11} aria-label="已置顶"/>}</strong>
            {workspace.directoryName && workspace.directoryName !== workspace.label && <small>{workspace.directoryName}</small>}</div>
          <IconButton label={`管理工作区：${workspace.label}`} tooltip="改名、置顶或移除" onClick={() => workspaceAction({ kind: 'manage', workspace })}><MoreHorizontal size={16}/></IconButton>
        </li>)}
      </ul> : <p className="settings-note">还没有工作区。{canAdd ? '' : '管理员配置可用目录后即可添加。'}</p>}
      {!canAdd && <p className="settings-note">当前实例没有配置可添加的目录根，添加工作区需要管理员先配置。</p>}
      {!!configuration.removedWorkspaces?.length && <>
        <h3 className="settings-subheading">已移除的工作区</h3>
        <ul className="settings-list">{configuration.removedWorkspaces.map(workspace => <li key={workspace.id} className="settings-removed">
          <div className="settings-removed-row">
            <button type="button" className="settings-expand" aria-expanded={opened === workspace.id} onClick={() => setOpened(opened === workspace.id ? undefined : workspace.id)}>
              <ChevronRight size={13}/><span className="settings-item-text"><strong>{workspace.label}</strong><small>查看原有对话；恢复后它们回到侧栏</small></span></button>
            <Button size="small" aria-label={`恢复工作区：${workspace.label}`} onClick={() => workspaceAction({ kind: 'restore', workspace })}><RotateCcw size={13}/>恢复</Button>
          </div>
          {opened === workspace.id && <div className="settings-removed-list">
            <ConversationResults {...results} rows={{ ...results.rows }} query={{ workspaceId: workspace.id }}/>
            <ConversationResults {...results} rows={{ ...results.rows }} query={{ workspaceId: workspace.id, archived: true }} hideEmpty label="已归档对话"/>
          </div>}
        </li>)}</ul>
      </>}
    </>}
  </section>;
}

function AccountSettings({ connection, logout, busy }: { connection: { text: string; state: 'online' | 'connecting' | 'offline' }; logout(): void; busy: boolean }) {
  const [version, setVersion] = useState<{ version: string; revision: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/version', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(async response => { if (response.ok) setVersion(versionSchema.parse(await response.json())); }).catch(() => {});
    return () => controller.abort();
  }, []);
  return <section className="settings-section settings-admin" aria-labelledby="account-title">
    <h2 id="account-title">管理员</h2>
    <p className="settings-lead">单管理员私人入口。</p>
    <div className="settings-card">
      <dl className="settings-facts">
        <div><dt>连接</dt><dd><ConnectionStatus {...connection}/></dd></div>
        <div><dt>版本</dt><dd>{version ? `v${version.version} · ${version.revision === 'development' ? '本地开发' : version.revision.slice(0, 8)}` : '正在读取…'}</dd></div>
      </dl>
      <div className="settings-actions"><Button disabled={busy} onClick={logout}>退出登录</Button></div>
    </div>
  </section>;
}
