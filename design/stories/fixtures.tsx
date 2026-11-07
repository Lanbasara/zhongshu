import type { Conversation, QueueView, TurnFileSummary, WorkbenchItem } from '../../src/shared/workbench.ts';
import type { ProcessStep } from '../../src/web/patterns/process.tsx';
import type { SubagentSummary, TeamSnapshot } from '../../src/web/patterns/subagents.tsx';
import type { DraftConfigurationCatalog } from '../../src/web/patterns/draft-configuration.tsx';

/*
 * Catalog fixtures. Every name, path, model and number here is invented and marked 示例;
 * none of it refers to a real instance, workspace, credential or person.
 */

export const workspaces = [
  { id: 'example-notes', label: '示例笔记', pinned: true },
  { id: 'example-site', label: '示例站点' },
  { id: 'example-research', label: '示例研究资料（名称很长时在侧栏里截断显示）' },
] as const;
export type ExampleWorkspace = (typeof workspaces)[number];

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
type ConversationStatus = Conversation['state']['status'];
export function exampleConversation(index: number, title: string, workspaceId: string, status: ConversationStatus, extra: Partial<Conversation> = {}): Conversation {
  return {
    id: uuid(index), title, harnessId: index % 2 ? 'codex' : 'dsh', workspaceId,
    configuration: { modelId: 'example-model', permissionId: 'example-permission' }, readiness: 'ready', archived: false,
    state: { status, pendingInputs: 0, configurationVerified: true }, error: null, createdAt: index, ...extra,
  };
}

/** One conversation per visible status, so the sidebar and search show every dot. */
export const conversations: Conversation[] = [
  exampleConversation(1, '整理示例周报', 'example-notes', 'running'),
  exampleConversation(2, '核对示例数据表', 'example-notes', 'waiting'),
  exampleConversation(3, '起草示例发布说明', 'example-notes', 'idle', { unread: true }),
  exampleConversation(4, '修复示例页面样式', 'example-site', 'failed', { unread: true }),
  exampleConversation(5, '迁移示例配置', 'example-site', 'unknown'),
  exampleConversation(6, '重写示例脚本', 'example-site', 'interrupted'),
  exampleConversation(7, '阅读示例论文', 'example-research', 'idle'),
  exampleConversation(8, '汇总示例访谈', 'example-research', 'idle',
    { subagents: { total: 3, running: 2, unverified: 0, resultsPending: false, revision: 1 } }),
  exampleConversation(9, '一段标题非常长的示例对话，用来检查侧栏、搜索和页头的截断表现', 'example-research', 'idle'),
];

export const exampleProcess: ProcessStep[] = [
  { id: 'step-1', name: '读取文件', status: 'completed', input: 'cat 示例/周报/数据表.csv', output: '日期,访问量,转化率\n2026-01-05,1200,3.1%\n2026-01-12,1340,\n2026-01-19,1295,3.4%' },
  { id: 'step-2', name: '运行命令', status: 'completed', input: 'python3 示例/脚本/补齐列.py 示例/周报/数据表.csv', output: '已补齐 1 列，共 14 行。' },
  { id: 'step-3', name: '修改文件', status: 'completed', input: '示例/周报/摘要.md', output: '写入 18 行。' },
];
export const longStep: ProcessStep = {
  id: 'step-long', name: '运行一段输入和输出都很长的示例命令', status: 'completed',
  input: 'node 示例/脚本/检查.mjs --mode=full --report=示例/报告/结果.json --include="示例/**/*.md" --exclude="示例/归档/**" --limit=500 --verbose',
  output: Array.from({ length: 40 }, (_, line) => `第 ${line + 1} 行 · 示例输出：检查 示例/文档/第${line + 1}篇.md，未发现问题。`).join('\n'),
};

export const exampleRun = 'example-run-1';
export const transcript: WorkbenchItem[] = [
  { id: 'item-user', kind: 'user', status: 'completed', runId: exampleRun, text: '把示例周报的数据表整理一下：补齐缺失的转化率，再写一段摘要。',
    references: [{ type: 'file', path: '示例/周报/数据表.csv' }] },
  ...exampleProcess.map((step): WorkbenchItem => ({ id: `item-${step.id}`, kind: 'tool', status: step.status, runId: exampleRun, text: '',
    tool: { name: step.name, ...(step.input ? { input: step.input } : {}), ...(step.output ? { output: step.output } : {}) } })),
  { id: 'item-reply', kind: 'assistant', status: 'completed', runId: exampleRun, text: [
    '数据表已经补齐，摘要写在 `示例/周报/摘要.md`。',
    '',
    '## 本周要点',
    '',
    '1. **访问量**比上周增加约 8%，主要来自第二周。',
    '2. **转化率**缺失的一行按前后两周的平均值补齐，已在表中标注。',
    '3. 没有发现重复日期。',
    '',
    '| 周 | 访问量 | 转化率 |',
    '| --- | --- | --- |',
    '| 第一周 | 1200 | 3.1% |',
    '| 第二周 | 1340 | 3.3%（补齐） |',
    '| 第三周 | 1295 | 3.4% |',
    '',
    '```bash',
    'python3 示例/脚本/补齐列.py 示例/周报/数据表.csv',
    '```',
  ].join('\n') },
];
export const turnFiles: ReadonlyMap<string, TurnFileSummary> = new Map([[exampleRun, {
  runId: exampleRun, limited: false, paths: ['示例/周报/数据表.csv', '示例/周报/摘要.md', '示例/周报/图表/访问量.svg', '示例/周报/归档/上周摘要.md'],
}]]);
export const exampleFiles = [
  '示例/周报/数据表.csv', '示例/周报/摘要.md', '示例/周报/图表/访问量.svg', '示例/周报/归档/上周摘要.md',
  '示例/周报/归档/很深的目录/还有一层/文件名也很长的示例说明文档.md', '示例/周报/附录.md', '示例/周报/术语.md', '示例/周报/清单.md',
];

/** A follow-up turn that is still running: a live process and a reply being written. */
export const runningRun = 'example-run-2';
export const runningTurn: WorkbenchItem[] = [
  { id: 'item-user-2', kind: 'user', status: 'completed', runId: runningRun, text: '再按月汇总一次，画一张趋势图。' },
  { id: 'item-tool-4', kind: 'tool', status: 'completed', runId: runningRun, text: '', tool: { name: '读取文件', input: 'cat 示例/周报/数据表.csv', output: '共 14 行。' } },
  { id: 'item-tool-5', kind: 'tool', status: 'running', runId: runningRun, text: '', tool: { name: '运行命令', input: 'python3 示例/脚本/按月汇总.py' } },
];

export const skillOptions = [
  { name: '示例：整理', description: '把零散材料整理成结构清晰的笔记。' },
  { name: '示例：核对', description: '逐条核对数字和出处，列出不一致的地方。' },
  { name: '示例：总结', description: '压缩长材料，保留结论和依据。' },
  { name: '示例：翻译', description: '在中英文之间翻译，保留术语表。' },
  { name: '示例：评审', description: '找出有具体触发条件和后果的问题。' },
].map((skill, index) => ({ id: String(index + 1).padStart(64, '0'), label: skill.name, ...skill }));

const entryId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
export const queueEntries: QueueView['entries'] = [
  { entryId: entryId(1), version: 0, status: 'waiting', content: { text: '这一轮结束后，再补一张按月汇总的表。' } },
  { entryId: entryId(2), version: 0, status: 'waiting', content: { text: '顺便检查摘要里引用的三个数字是否都能在数据表里找到，找不到的标出来。', references: [{ type: 'file', path: '示例/周报/摘要.md' }] } },
  { entryId: entryId(3), version: 0, status: 'waiting', content: { text: '最后把本周的变化列成清单。' } },
];

export const draftCatalogs: DraftConfigurationCatalog[] = [
  { id: 'codex', available: true, defaultModelId: 'example-fast',
    models: [
      { id: 'example-fast', label: '示例模型 · 快速', defaultReasoningEffort: 'medium',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: `示例档位 ${id}` })) },
      { id: 'example-deep', label: '示例模型 · 深入（名称较长）', defaultReasoningEffort: 'high',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, label: `示例档位 ${id}` })) },
      { id: 'example-plain', label: '示例模型 · 无深度档位' },
    ],
    permissions: [
      { id: 'read-only', label: '只读', description: '示例：只能读取工作区。' },
      { id: 'workspace-write', label: '工作区读写', description: '示例：可以在工作区内修改文件。' },
      { id: 'full', label: '完全访问', description: '示例：不受工作区限制。' },
    ] },
  { id: 'dsh', available: true,
    models: [{ id: 'example-other', label: '另一个示例模型', reasoningEfforts: ['off', 'low', 'high'].map(id => ({ id, label: `示例档位 ${id}` })) }],
    permissions: [{ id: 'read-only', label: '只读', description: '示例：只能读取工作区。' }, { id: 'workspace-write', label: '工作区读写', description: '示例：可以在工作区内修改文件。' }] },
];

export const subagents: SubagentSummary[] = [
  { id: 'agent-1', name: 'reader_a', task: '示例任务：读取第一批资料', role: 'worker', model: '示例模型 · 中', status: 'running', time: '已运行 4 分钟' },
  { id: 'agent-2', name: 'reader_b', task: '示例任务：读取第二批资料', role: 'worker', model: '示例模型 · 中', status: 'running', time: '已运行 4 分钟' },
  { id: 'agent-3', name: 'checker', task: '示例任务：核对数字', role: 'explorer', model: '示例模型 · 低', status: 'completed', time: '10:12 完成' },
  { id: 'agent-4', name: 'checker_detail', task: '示例任务：核对附录', role: 'explorer', model: '示例模型 · 低', status: 'completed', time: '10:08 完成', spawnedBy: 'checker' },
  { id: 'agent-5', name: 'summarizer', task: '示例任务：写摘要', model: '示例模型 · 中', status: 'failed', time: '10:15 未完成' },
  { id: 'agent-6', name: 'layout', task: '示例任务：排版', model: '示例模型 · 中', status: 'interrupted', time: '10:16 已停止' },
  { id: 'agent-7', name: 'idle_helper', task: '示例任务：待命', model: '示例模型 · 低', status: 'idle', time: '尚未开始' },
  { id: 'agent-8', name: 'outside_check', task: '示例任务：外部复算', status: 'completed', time: '10:20 完成', external: '示例外部任务' },
];
export const team: TeamSnapshot = {
  members: [
    { id: 'lead', name: 'lead', status: 'running', lead: true },
    { id: 'member-1', name: 'reader_a', status: 'running', agentId: 'agent-1' },
    { id: 'member-2', name: 'reader_b', status: 'running', agentId: 'agent-2' },
    { id: 'member-3', name: 'checker', status: 'idle', agentId: 'agent-3' },
    { id: 'member-4', name: 'summarizer', status: 'unknown', agentId: 'agent-5' },
  ],
  tasks: [
    { id: 'task-1', title: '示例任务：读取第一批资料', status: 'in_progress', owner: 'reader_a', writeScopes: ['示例/工作/第一批.md'],
      description: '读取第一批示例资料，整理成要点清单，并标注每一条的出处。交付 示例/工作/第一批.md。' },
    { id: 'task-2', title: '示例任务：核对数字', status: 'completed', owner: 'checker', writeScopes: ['示例/工作/核对.md', '示例/工作/原始数据'],
      description: '逐条核对摘要中的数字是否能在原始数据里找到，列出不一致的地方和可能的原因。' },
    { id: 'task-3', title: '示例任务：写摘要', status: 'pending', owner: 'summarizer', writeScopes: ['示例/工作/摘要.md'],
      description: '在前两项完成后写一段不超过三百字的摘要。' },
  ],
};
export function subagentTranscript(agent: SubagentSummary): WorkbenchItem[] {
  const run = `child-${agent.id}`;
  const running = agent.status === 'running' || agent.status === 'stopping';
  return [
    { id: `${run}-a`, kind: 'assistant', text: `收到，开始「${agent.task ?? agent.name}」。`, status: 'completed', runId: run },
    { id: `${run}-t1`, kind: 'tool', text: '', status: 'completed', runId: run, tool: { name: '读取文件', input: 'ls 示例/资料', output: '第一篇.md\n第二篇.md' } },
    { id: `${run}-t2`, kind: 'tool', text: '', status: running ? 'running' : 'completed', runId: run, tool: { name: '运行命令', input: 'python3 示例/脚本/整理.py' } },
    ...(running ? [] : [{ id: `${run}-done`, kind: 'assistant' as const, text: '已完成，结果写在 `示例/工作/` 下。', status: 'completed' as const, runId: run }]),
  ];
}
