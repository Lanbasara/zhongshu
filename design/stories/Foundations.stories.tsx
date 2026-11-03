import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Settings } from 'lucide-react';
import { tokens, timing } from '../../src/web/ui/tokens.ts';
import { BrandMark, Button, IconButton, Information, Menu, MenuItem } from '../../src/web/ui/controls.tsx';
function Foundations() {
  const [selected,setSelected] = useState('选择一个动作');
  return <div style={{ padding:40, maxWidth:1000, margin:'auto' }}><BrandMark/><h1 style={{ font:'32px var(--zs-font-reading)', margin:'24px 0 12px' }}>静处见深</h1><p>安静、清晰、有质感。导航紧凑，正文舒展，动作利落。</p>
    <h2 style={{ margin:'32px 0 16px' }}>语义颜色</h2><div style={{ display:'flex',gap:16,flexWrap:'wrap' }}>{['surface','sidebar','surface-selected','text','text-secondary','action','danger','success'].map(role => <div key={role}><div style={{ background:`var(--zs-${role})`,width:90,height:60,border:'1px solid var(--zs-border)',borderRadius:8 }}/><small>{role}</small></div>)}</div>
    <h2 style={{ margin:'32px 0 16px' }}>同一套控件</h2><div style={{ display:'flex',alignItems:'center',gap:12,flexWrap:'wrap' }}><Button variant="primary" onClick={() => setSelected('主操作')}>继续工作</Button><Button onClick={() => setSelected('次操作')}>打开文件</Button><Button disabled>暂不可用</Button><IconButton label="设置"><Settings size={17}/></IconButton><Menu label="添加" trigger={<Plus size={17}/>}><MenuItem onSelect={() => setSelected('添加材料')}>添加材料</MenuItem></Menu><Information label="交互约定" summary={<span>查看说明</span>}><p>菜单支持键盘；关闭弹层后回到入口。</p></Information></div><p role="status" style={{ marginTop:12 }}>{selected}</p>
    <h2 style={{ margin:'32px 0 16px' }}>文字与节奏</h2><p style={{ fontFamily:'var(--zs-font-reading)', fontSize:24 }}>阅读标题 · 从规模，走向系统效率</p><p style={{ fontSize:15,lineHeight:1.85,marginTop:12 }}>正文使用界面字体保持长文可读。标题在适合的位置使用阅读字体，辅助文字保持层次和足够对比度。</p><p style={{ marginTop:12,color:'var(--zs-text-muted)',fontSize:12 }}>即时反馈 {timing.response}ms · 状态 {timing.state}ms · 空间 {timing.surface}ms；尊重系统减少动态效果。</p>
    <details style={{ marginTop:32 }}><summary>设计值的唯一来源</summary><pre style={{ overflow:'auto',fontSize:12 }}>{JSON.stringify(tokens,null,2)}</pre></details></div>;
}
export default {title:'设计基础/语言与控件',component:Foundations} satisfies Meta<typeof Foundations>;
export const Overview: StoryObj<typeof Foundations> = {};
