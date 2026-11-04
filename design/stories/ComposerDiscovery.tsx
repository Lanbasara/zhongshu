import { useState } from 'react';
import { ComposerView } from '../../src/web/patterns/composer.tsx';
import { SkillEditor, ComposerUsage } from '../../src/web/patterns/composer-extras.tsx';
import { skillLabelText, skillLimit, type SkillReference } from '../../src/shared/content.ts';
import './composer-discovery.css';

const skills = [
  { id: 'zhixing:align', name: 'Zhixing: Align', description: '梳理问题和分歧，确认下一步需要决定什么。' },
  { id: 'zhixing:plan', name: 'Zhixing: Plan', description: '把明确的目标拆成可独立验证的实现步骤。' },
  { id: 'zhixing:review', name: 'Zhixing: Review', description: '检查改动，找出有具体触发条件和后果的缺陷。' },
  { id: 'zhixing:verify', name: 'Zhixing: Verify', description: '从用户入口驱动行为，记录实际运行证据。' },
  { id: 'research', name: 'Research', description: '查找原始资料，核对事实与来源。' },
  { id: 'summarize', name: 'Summarize', description: '整理长材料，保留关键结论和出处。' },
] as const;
const loadSkills = async () => skills.map(skill => ({ ...skill, label: skill.name }));

export function ComposerDiscovery({ contextAvailable = true }: { contextAvailable?: boolean }) {
  const [text, setText] = useState('');
  const [spans, setSpans] = useState<SkillReference[]>([]);
  const [message, setMessage] = useState('');
  const [material, setMaterial] = useState(false);
  function send() {
    setMessage(text.trim() || '已添加演示材料。');
    setText('');
    setSpans([]);
    setMaterial(false);
  }
  return <main className="prototype-discovery">
    <header>
      <span>中书 · 输入区原型</span>
      <h1>技能与对话用量</h1>
      <p>输入 <kbd>/zhi</kbd> 筛选技能，按 <kbd>Tab</kbd> 插入。点按输入框下方的数字可查看用量。</p>
    </header>
    <div className="prototype-discovery-transcript" aria-live="polite">
      {message && <div><small>演示消息</small><p>{message}</p></div>}
    </div>
    <ComposerView value={text} onChange={setText} onSend={send} onStop={() => {}} onImages={() => setMaterial(true)} onFiles={() => setMaterial(true)}
      editDisabled={false} imagesDisabled={false} filesDisabled={false} sendDisabled={!text.trim() && !material} sending={false} running={false}
      model="示例模型" permission="工作区读写" configurationNote="固定在这段演示对话的配置。"
      hasMaterials={material} materials={<button type="button" className="zs-button zs-button-secondary" onClick={() => setMaterial(false)}>移除演示材料</button>}
      renderEditor={editor => <SkillEditor editor={editor} spans={spans} picker={{ load: loadSkills, format: skillLabelText, limit: skillLimit }}
        onEdit={(next, references) => { setText(next); setSpans(references); }}/>}
      footerDetails={<ComposerUsage usage={{ total: 176_222_262,
        ...(contextAvailable ? { context: { used: 188_743, capacity: 1_048_576, estimated: true } } : {}) }}/>}/>
    <p className="prototype-discovery-note">技能、消息与用量均为演示数据</p>
  </main>;
}
