import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Play } from 'lucide-react';
import { themeCss, timing, tokens } from '../../src/web/ui/tokens.ts';
import { BrandMark, Button, StatusDot, type StatusKind } from '../../src/web/ui/controls.tsx';
import { ConnectionStatus } from '../../src/web/patterns/sidebar.tsx';
import { Page, Section, Stage, phone } from './catalog.tsx';

/*
 * Everything on these pages is read from tokens.ts (or the theme it generates), so a new or
 * changed token shows up here without editing the story. Groupings are by name prefix only.
 */
const generated = Object.fromEntries([...themeCss().matchAll(/--zs-([\w-]+): ([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
const isPalette = (name: string) => /^[a-z]+-\d+$/.test(name);
const aliasOf = (value: string) => /^var\(--zs-([\w-]+)\)$/.exec(value)?.[1];
function resolve(value: string, depth = 0): string {
  const name = aliasOf(value);
  return name && tokens[name] !== undefined && depth < 8 ? resolve(tokens[name]!, depth + 1) : value;
}
const isColor = (value: string) => /^(#|rgba?\()/.test(resolve(value));
const pick = (pattern: RegExp) => Object.entries(tokens).filter(([name]) => pattern.test(name));
const variable = (name: string) => `var(--zs-${name})`;

function Token({ name, value }: { name: string; value: string }) {
  const alias = aliasOf(value);
  return <span className="catalog-token">--zs-{name}{alias ? ` → ${alias}` : ''} · {resolve(value)}</span>;
}
function Swatch({ name, value }: { name: string; value: string }) {
  return <div className="catalog-swatch"><i style={{ background: variable(name) }}/><strong>{name}</strong><Token name={name} value={value}/></div>;
}

const colorGroups: { title: string; note: string; test: RegExp }[] = [
  { title: '表面', note: '页面、侧栏、输入、悬停与选中的底色。', test: /^(surface|canvas|sidebar|scrim|selection)/ },
  { title: '文字', note: '正文与界面文字的层次；正文默认 text-body，辅助说明用 text-muted。', test: /^text/ },
  { title: '线条', note: '分隔线、输入框边框与焦点边框。', test: /^(line|border)/ },
  { title: '强调与操作', note: '唯一的强调色（靛蓝）用于主操作、焦点和选中。', test: /^(accent|action|focus)/ },
  { title: '结果语义', note: '成功、危险与警告的文字和底色；状态点的颜色见“状态色”。', test: /^(success|danger|warning)/ },
];
function Colors() {
  const semantic = Object.entries(tokens).filter(([name, value]) => !isPalette(name) && !name.startsWith('status-') && isColor(value));
  const grouped = new Set<string>();
  const hues = [...new Set(Object.keys(tokens).filter(isPalette).map(name => name.replace(/-\d+$/, '')))];
  return <Page title="颜色" lead="组件只使用语义颜色。语义颜色指向底层色板；以后增加深色主题时只需要重新定义语义层。">
    {colorGroups.map(group => {
      const items = semantic.filter(([name]) => group.test.test(name));
      items.forEach(([name]) => grouped.add(name));
      return <Section key={group.title} title={group.title} note={group.note}>
        <div className="catalog-grid">{items.map(([name, value]) => <Swatch key={name} name={name} value={value}/>)}</div>
      </Section>;
    })}
    {semantic.some(([name]) => !grouped.has(name)) && <Section title="其他语义颜色" note="尚未归入上面分组的新颜色。">
      <div className="catalog-grid">{semantic.filter(([name]) => !grouped.has(name)).map(([name, value]) => <Swatch key={name} name={name} value={value}/>)}</div>
    </Section>}
    <Section title="底层色板" note="只被语义颜色引用，组件不直接使用。">
      {hues.map(hue => <div key={hue} style={{ marginBottom: 16 }}><p className="catalog-muted" style={{ marginBottom: 8 }}>{hue}</p>
        <div className="catalog-grid">{pick(new RegExp(`^${hue}-\\d+$`)).map(([name, value]) => <Swatch key={name} name={name} value={value}/>)}</div></div>)}
    </Section>
  </Page>;
}

/** What each status means; Record keeps this list complete whenever StatusKind changes. */
const statusMeaning: Record<StatusKind, { label: string; shape: string }> = {
  running: { label: '运行中 / 正在准备', shape: '旋转的圆环' },
  waiting: { label: '等待处理', shape: '实心圆点' },
  unread: { label: '已完成，还没看', shape: '实心圆点（出现时弹入）' },
  failed: { label: '执行失败', shape: '实心圆点' },
  unknown: { label: '待核实 / 准备未完成', shape: '空心圆环' },
  interrupted: { label: '已中断', shape: '空心圆环' },
  idle: { label: '就绪', shape: '留空占位，保持对齐' },
};
function Status() {
  return <Page title="状态色" lead="一种状态只有一种形状和颜色：进行中旋转，结果是实心点，需要判断的是空心环。状态点同时用于侧栏、页头、搜索和提示。">
    <Section title="StatusDot">
      <table className="catalog-table"><thead><tr><th>示例</th><th>status</th><th>含义</th><th>形状</th><th>颜色令牌</th></tr></thead><tbody>
        {(Object.keys(statusMeaning) as StatusKind[]).map(status => <tr key={status}>
          <td><StatusDot status={status} label={statusMeaning[status].label}/></td><td><code>{status}</code></td>
          <td>{statusMeaning[status].label}</td><td className="catalog-muted">{statusMeaning[status].shape}</td>
          <td>{tokens[`status-${status}`] ? <Token name={`status-${status}`} value={tokens[`status-${status}`]!}/> : <span className="catalog-muted">无颜色</span>}</td>
        </tr>)}
      </tbody></table>
    </Section>
    <Section title="状态颜色令牌" note="从 tokens.ts 中所有 status-* 读取。">
      <div className="catalog-grid">{pick(/^status-/).map(([name, value]) => <Swatch key={name} name={name} value={value}/>)}</div>
    </Section>
  </Page>;
}

function Typography() {
  return <Page title="文字" lead="界面与正文使用同一套无衬线字体，代码使用等宽字体。字号按角色命名，而不是按大小命名。">
    <Section title="字体">
      <Stage stack>{pick(/^font-/).map(([name, value]) => <div key={name}>
        <p style={{ fontFamily: variable(name), fontSize: 18 }}>中书 · 示例文字 Aa Bb 0123456789</p><Token name={name} value={value}/>
      </div>)}</Stage>
    </Section>
    <Section title="字号">
      <table className="catalog-table"><thead><tr><th>令牌</th><th>值</th><th>示例</th></tr></thead><tbody>
        {pick(/^type-/).sort((a, b) => parseFloat(a[1]) - parseFloat(b[1])).map(([name, value]) => <tr key={name}>
          <td><code>--zs-{name}</code></td><td className="catalog-muted">{value}</td>
          <td style={{ fontSize: variable(name), fontFamily: name === 'type-code' ? variable('font-code') : undefined }}>整理示例周报 Weekly 2026</td>
        </tr>)}
      </tbody></table>
    </Section>
    <Section title="行高">
      <div className="catalog-grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))' }}>{pick(/^line-/).filter(([, value]) => !isColor(value)).map(([name, value]) => <Stage key={name} stack>
        <Token name={name} value={value}/>
        <p style={{ lineHeight: variable(name), fontSize: 'var(--zs-type-body)', color: 'var(--zs-text-body)' }}>这是一段示例正文，用来比较不同行高下的阅读节奏。长段落需要更宽松的行距，控件文字则保持紧凑。</p>
      </Stage>)}</div>
    </Section>
  </Page>;
}

function Spacing() {
  const sizes = pick(/-(width|height)$/);
  return <Page title="间距与尺寸" lead="间距以 4px 为单位；控件高度区分紧凑、默认、主要和触控四档。">
    <Section title="间距">
      <table className="catalog-table"><tbody>{pick(/^space-/).map(([name, value]) => <tr key={name}>
        <td style={{ width: 200 }}><code>--zs-{name}</code></td><td style={{ width: 80 }} className="catalog-muted">{value}</td>
        <td><div className="catalog-bar" style={{ width: variable(name) }}/></td>
      </tr>)}</tbody></table>
    </Section>
    <Section title="控件高度" note="手机上可点按的控件至少使用 control-touch。">
      <Stage>{pick(/^control-/).map(([name, value]) => <div key={name} style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
        <span className="catalog-box" style={{ height: variable(name), width: 140, borderRadius: 'var(--zs-radius-control)' }}>{value}</span><code className="catalog-token">{name}</code>
      </div>)}</Stage>
    </Section>
    <Section title="布局尺寸">
      <table className="catalog-table"><tbody>{sizes.map(([name, value]) => <tr key={name}>
        <td style={{ width: 200 }}><code>--zs-{name}</code></td><td style={{ width: 80 }} className="catalog-muted">{value}</td>
        <td><div className="catalog-bar" style={{ width: `min(100%, ${variable(name)})` }}/></td>
      </tr>)}</tbody></table>
    </Section>
  </Page>;
}

function Shape() {
  const layers = pick(/^layer-/).sort((a, b) => Number(a[1]) - Number(b[1]));
  return <Page title="圆角、阴影与层级" lead="圆角随物体大小增大；阴影只用在浮起的表面上。">
    <Section title="圆角">
      <Stage>{pick(/^radius-/).map(([name, value]) => <div key={name} style={{ display: 'grid', gap: 6 }}>
        <span className="catalog-box" style={{ borderRadius: variable(name) }}>{value}</span><code className="catalog-token">{name}</code>
      </div>)}</Stage>
    </Section>
    <Section title="阴影与焦点环">
      <div className="catalog-grid" style={{ gap: 24 }}>{pick(/^(shadow|elevation|ring)-/).map(([name, value]) => <div key={name} style={{ display: 'grid', gap: 8 }}>
        <div className="catalog-shadow" style={{ boxShadow: variable(name), border: value === 'none' ? '1px dashed var(--zs-line)' : undefined }}>{name}</div>
        <Token name={name} value={value}/>
      </div>)}</div>
    </Section>
    <Section title="层级" note="越往下越靠上层。">
      <table className="catalog-table"><tbody>{layers.map(([name, value]) => <tr key={name}><td><code>--zs-{name}</code></td><td>{value}</td></tr>)}</tbody></table>
    </Section>
  </Page>;
}

function bezier(value: string) {
  const points = /cubic-bezier\(([^)]+)\)/.exec(value)?.[1]?.split(',').map(Number);
  if (!points || points.length !== 4 || points.some(Number.isNaN)) return undefined;
  const [x1, y1, x2, y2] = points as [number, number, number, number];
  const s = 140, o = 10;
  return `M${o} ${o + s} C${o + x1 * s} ${o + (1 - y1) * s} ${o + x2 * s} ${o + (1 - y2) * s} ${o + s} ${o}`;
}
function Motion() {
  const durations = Object.entries(generated).filter(([name]) => name.startsWith('duration-'));
  const eases = Object.entries(generated).filter(([name]) => name.startsWith('ease'));
  const [ease, setEase] = useState(eases[0]?.[0] ?? 'ease');
  const [moved, setMoved] = useState<Record<string, boolean>>({});
  const play = (name?: string) => setMoved(current => {
    if (name) return { ...current, [name]: !current[name] };
    const next = !durations.every(([key]) => current[key]);
    return Object.fromEntries(durations.map(([key]) => [key, next]));
  });
  return <Page title="动效" lead={<>时长与缓动由 tokens.ts 的 timing 生成，Motion 也读同一份数值（{Object.entries(timing).filter(([key]) => key !== 'ease').map(([key, value]) => `${key} ${String(value)}ms`).join(' · ')}）。系统开启“减少动态效果”时，响应、状态、表面三档缩短为 1ms，持续旋转停止。</>}>
    <Section title="时长" note="点“播放”比较不同时长；切换缓动曲线看同一时长下的手感。">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {eases.map(([name]) => <Button key={name} size="small" variant={ease === name ? 'primary' : 'secondary'} aria-pressed={ease === name} onClick={() => setEase(name)}>{name}</Button>)}
        <Button size="small" variant="quiet" onClick={() => play()}><Play size={13}/>全部播放</Button>
      </div>
      <div style={{ display: 'grid', gap: 14 }}>{durations.map(([name, value]) => <div className="catalog-motion-row" key={name}>
        <div><code className="catalog-token">--zs-{name}</code><div className="catalog-muted">{value}</div></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button size="small" onClick={() => play(name)}>播放</Button>
          <div className="catalog-track" style={{ flex: 1 }}><i style={{
            left: moved[name] ? 'calc(100% - 30px)' : 6, transition: `left ${variable(name)} ${variable(ease)}`,
          }}/></div>
        </div>
      </div>)}</div>
    </Section>
    <Section title="缓动曲线">
      <Stage>{eases.map(([name, value]) => <div key={name} style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
        <svg className="catalog-curve" viewBox="0 0 160 160" role="img" aria-label={`${name} 曲线`} style={name === ease ? { borderColor: 'var(--zs-accent-line)' } : undefined}>
          <line x1="10" y1="150" x2="150" y2="10"/>{bezier(value) && <path d={bezier(value)}/>}</svg>
        <code className="catalog-token">{name}</code><span className="catalog-muted">{value}</span>
      </div>)}</Stage>
    </Section>
    <Section title="持续动效" note="activity 用于运行中的旋转，breathing 用于连接中的呼吸。">
      <Stage><StatusDot status="running" label="运行中"/><span className="catalog-muted">duration-activity</span>
        <span style={{ width: 24 }}/><ConnectionStatus state="connecting" text="正在重新连接"/><span className="catalog-muted">duration-breathing</span></Stage>
    </Section>
  </Page>;
}

function Brand() {
  return <Page title="品牌标识" lead="“三根柱”标识，与 public/icon.svg 是同一张图。标识使用强调色，不随工作区改变。">
    <Section title="尺寸">
      <Stage>{[16, 20, 28, 48, 96].map(size => <div key={size} style={{ display: 'grid', gap: 8, justifyItems: 'center' }}><BrandMark size={size}/><span className="catalog-muted">{size}px</span></div>)}</Stage>
    </Section>
    <Section title="在侧栏中" note="标识与产品名组成侧栏顶部的品牌行。">
      <Stage tone="sidebar"><div className="sidebar-brand" style={{ padding: 0, height: 'auto' }}><BrandMark size={20}/><span className="sidebar-name">中书</span></div></Stage>
    </Section>
  </Page>;
}

const meta = { title: '设计基础/设计令牌', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const ColorTokens: Story = { name: '颜色', render: () => <Colors/> };
export const StatusTokens: Story = { name: '状态色', render: () => <Status/> };
export const TypeTokens: Story = { name: '文字', render: () => <Typography/> };
export const SpaceTokens: Story = { name: '间距与尺寸', render: () => <Spacing/> };
export const ShapeTokens: Story = { name: '圆角、阴影与层级', render: () => <Shape/> };
export const MotionTokens: Story = { name: '动效', render: () => <Motion/> };
export const BrandTokens: Story = { name: '品牌标识', render: () => <Brand/> };
export const PhoneType: Story = { name: '文字 · 手机', render: () => <Typography/>, globals: phone };
