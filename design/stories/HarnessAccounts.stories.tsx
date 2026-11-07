import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AccountAttentionBanner, HarnessAccountCard, type AccountState, type DeviceLogin, type HarnessAccount } from '../../src/web/patterns/harness-accounts.tsx';
import { Button } from '../../src/web/ui/controls.tsx';
import { Page, Section, Stage, phone, useReadout } from './catalog.tsx';

/** Story-only examples of Harness account status (ADR 0015). Nothing reaches a Harness; the code is fake. */
const now = Date.UTC(2026, 10, 7, 13, 5);
const week = Date.UTC(2026, 10, 14, 7, 31);
const codex = (state: AccountState): HarnessAccount => ({
  harness: 'Codex', state, canLogin: true, checkedAt: state === 'checking' ? undefined : now,
  ...(state === 'valid' || state === 'unverified' || state === 'rejected' ? { identity: 'h***@gmail.com', plan: 'Pro' } : {}),
  ...(state === 'valid' ? { usage: { label: '本周额度', usedPercent: 74, resetsAt: week } } : {}),
});
const dsh = (state: AccountState): HarnessAccount => ({
  harness: 'DSH', state, canLogin: false, checkedAt: state === 'checking' ? undefined : now,
  ...(state === 'valid' || state === 'unverified' ? { identity: 'DeepSeek 账号 138****9119' } : {}),
});
const waiting: DeviceLogin = { status: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHJ' };

function AccountTab({ codexState, dshState }: { codexState: AccountState; dshState: AccountState }) {
  const [readout, say] = useReadout();
  const [codexAccount, setCodex] = useState(codex(codexState));
  const [login, setLogin] = useState<DeviceLogin>();
  const startLogin = () => { say('向 Codex 发起设备码登录'); setLogin({ status: 'starting' }); setTimeout(() => setLogin(waiting), 900); };
  return <div className="settings" style={{ height: '100dvh' }}>
    <div className="settings-tabs" role="tablist" aria-label="设置">
      {['工作区', '插件', '存储', '通知', '账户'].map(label => <button key={label} type="button" role="tab" aria-selected={label === '账户'}>{label}</button>)}
    </div>
    <div className="settings-scroll"><div className="settings-column">
      <section className="settings-section" aria-labelledby="harness-accounts-title">
        <h2 id="harness-accounts-title">Harness 账号</h2>
        <p className="settings-lead">Codex 和 DSH 各用自己的厂商账号工作。中书定期向厂商核实，失效时提醒你。凭据一直留在各自的 Harness 里，中书不保存。</p>
        <div className="account-list">
          <HarnessAccountCard account={codexAccount} login={login} onCheck={() => { say('重新核实 Codex'); setCodex({ ...codexAccount, state: 'checking' }); setTimeout(() => setCodex(codex(codexState)), 800); }}
            onLogin={startLogin} onCancelLogin={() => { say('取消登录'); setLogin(undefined); }} onCopy={text => say(`复制登录码 ${text}`)}/>
          <HarnessAccountCard account={dsh(dshState)} onCheck={() => say('重新核实 DSH')} onLogin={() => {}} onCancelLogin={() => {}} onCopy={() => {}}/>
        </div>
        {login?.status === 'waiting' && <p className="settings-note">示例：<Button size="small" variant="quiet" onClick={() => { setLogin(undefined); setCodex(codex('valid')); say('原生通知登录完成，重新核实为可用'); }}>模拟在手机上完成登录</Button></p>}
      </section>
      <section className="settings-section" style={{ marginTop: 32 }} aria-labelledby="admin-title">
        <h2 id="admin-title">管理员</h2>
        <p className="settings-lead">单管理员私人入口。（这里是现有的连接、版本和退出登录，不变。）</p>
      </section>
      {readout}
    </div></div>
  </div>;
}

function Catalog() {
  const [readout, say] = useReadout();
  const noop = () => {};
  return <Page title="Harness 账号" lead={<>每端显示是否可用、账号、额度和最近核实时间。只有向厂商核实通过才算可用。{readout}</>}>
    <Section title="Codex 的各种状态" note="可用时显示本周额度；失效或未登录时可在页内用设备码登录。">
      <Stage stack>{(['valid', 'rejected', 'signed-out', 'unverified', 'disconnected', 'checking'] as const).map(state =>
        <HarnessAccountCard key={state} account={codex(state)} onCheck={() => say(`重新核实（${state}）`)} onLogin={() => say('登录')} onCancelLogin={noop} onCopy={noop}/>)}</Stage>
    </Section>
    <Section title="DSH 的各种状态" note="DSH 不提供页内登录，需要处理时说明由操作者完成。">
      <Stage stack>{(['valid', 'unverified', 'rejected', 'signed-out', 'disconnected'] as const).map(state =>
        <HarnessAccountCard key={state} account={dsh(state)} onCheck={() => say(`重新核实 DSH（${state}）`)} onLogin={noop} onCancelLogin={noop} onCopy={noop}/>)}</Stage>
    </Section>
    <Section title="设备码登录" note="登录码只显示在发起登录的这个页面；刷新后需要重新发起。新发起会顶掉旧的一次。">
      <Stage stack>
        <HarnessAccountCard account={codex('rejected')} login={{ status: 'starting' }} onCheck={noop} onLogin={noop} onCancelLogin={noop} onCopy={noop}/>
        <HarnessAccountCard account={codex('rejected')} login={waiting} onCheck={noop} onLogin={noop} onCancelLogin={() => say('取消')} onCopy={text => say(`复制 ${text}`)}/>
        <HarnessAccountCard account={codex('rejected')} login={{ status: 'failed', reason: '登录码已过期，请重新发起。' }} onCheck={noop} onLogin={() => say('再试一次')} onCancelLogin={noop} onCopy={noop}/>
      </Stage>
    </Section>
    <Section title="主界面的提醒" note="某一端无法开始新工作（未登录、失效、未连接）时，出现在对话区上方；“暂时无法核实”不打扰。离开页面时另有推送。">
      <Stage stack>
        <AccountAttentionBanner accounts={[codex('rejected'), dsh('valid')]} onOpen={() => say('打开 设置 → 账户')}/>
        <AccountAttentionBanner accounts={[codex('valid'), dsh('signed-out')]} onOpen={() => say('打开 设置 → 账户')}/>
      </Stage>
    </Section>
  </Page>;
}

const meta = {
  title: '工作台/Harness 账号',
  component: AccountTab,
  args: { codexState: 'rejected', dshState: 'valid' },
  argTypes: {
    codexState: { control: 'select', options: ['valid', 'rejected', 'signed-out', 'unverified', 'disconnected', 'checking'] },
    dshState: { control: 'select', options: ['valid', 'unverified', 'rejected', 'signed-out', 'disconnected'] },
  },
  render: args => <AccountTab key={JSON.stringify(args)} {...args}/>,
} satisfies Meta<typeof AccountTab>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = { name: '桌面 · 设置 · 账户' };
export const Phone: Story = { name: '手机 · 设置 · 账户', globals: phone };
export const States: Story = { name: '状态一览', render: () => <Catalog/> };
export const PhoneStates: Story = { name: '手机 · 状态一览', render: () => <Catalog/>, globals: phone };
