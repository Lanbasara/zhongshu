import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { BrandMark, Button } from '../../src/web/ui/controls.tsx';
import { WorkbenchFrame } from '../../src/web/patterns/workbench-frame.tsx';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { Transcript } from '../../src/web/conversation-content.tsx';
function Workbench() {
  const [navigation,setNavigation] = useState(false);
  const [reader,setReader] = useState(false);
  const [text,setText] = useState('');
  return <WorkbenchFrame navigationOpen={navigation} onNavigationChange={setNavigation}
    sidebar={<><div className="workbench-brand"><BrandMark/><span>中书</span></div><Button onClick={() => setText('')}>新对话</Button><nav><p className="nav-label">研究工作区 · 示例</p><div className="conversation-row"><button className="conversation-link selected" onClick={() => setNavigation(false)}><strong>AI 基础设施的下一步</strong><span>示例 · 未连接服务</span></button></div></nav></>}
    header={<><div className="conversation-heading"><h1>AI 基础设施的下一步</h1><p>隔离布局与内容压力场景</p></div><Button onClick={() => setReader(!reader)}>工作区文件</Button></>}
    reader={reader && <aside className="workspace-reader"><div className="workspace-reader-bar"><Button onClick={() => setReader(false)}>关闭阅读器</Button></div><article className="workspace-reader-content"><h2>研究笔记</h2><p>分栏以后，正文与输入继续共享阅读轴线。真实文件读取和保存由产品功能负责。</p></article></aside>}>
    <div className="message-scroll"><div className="message-column"><Transcript conversation="example" onQuote={() => setText('引用示例内容')} items={[
      { id:'example-user',kind:'user',text:'帮我整理一下 AI 基础设施下一阶段值得关注的方向。',status:'completed',runId:'example' },
      { id:'example-answer',kind:'assistant',text:'我把线索整理成了三个层次。\n\n## 从规模，走向系统效率\n\n1. **计算的重心正在移动**\n\n   从训练集群，延伸到推理场景中的延迟、成本与利用率。\n\n2. **连接决定系统的上限**\n\n   芯片之外，网络、存储与调度共同决定有效产出。\n\n3. **能源约束值得单独看待**\n\n   电力接入、散热与部署周期，有各自不同的时间尺度。',status:'completed',runId:'example' }
    ]}/></div></div><div className="composer-region"><ComposerView value={text} onChange={setText} onSend={() => setText('')} onStop={() => {}} onImages={() => {}} onFiles={() => setReader(true)} editDisabled={false} imagesDisabled={false} filesDisabled={false} sendDisabled={!text.trim()} sending={false} running={false} model="示例模型" permission="示例配置" configurationNote="此页面用于布局验证。" hasMaterials={false}/></div>
  </WorkbenchFrame>;
}
export default {title:'产品模式/完整工作台',component:Workbench} satisfies Meta<typeof Workbench>;
export const Reading: StoryObj<typeof Workbench> = {};
