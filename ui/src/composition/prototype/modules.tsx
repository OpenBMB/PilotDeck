import { useState } from 'react';
import { ArrowUp, Check, CheckCircle2, ChevronRight, Database, FileText, Search, ShieldCheck, Workflow, Wrench, X } from 'lucide-react';
import { Button } from '../../shared/view/ui/Button';
import { Input } from '../../shared/view/ui/Input';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { slotContracts } from '../assemble';

export function ChatPage({ children }: SurfaceProps) {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState(['整理知识库中的发布流程，生成上线检查清单。']);
  return <div className="prototype-conversation">
    <div className="prototype-transcript">
      {messages.map((message, index) => <div key={index}>
        <div className="prototype-user-message">{message}</div>
        <div className="prototype-assistant"><img src="/pilotdeck-p-mark-compact.png" alt="PilotDeck" /><div><strong>PilotDeck</strong><p>已整理本次请求。可以继续补充范围或查看当前工作区的模块信息。</p></div></div>
      </div>)}
    </div>
    {children}
    <form className="prototype-composer" onSubmit={event => { event.preventDefault(); if (draft.trim()) { setMessages([...messages, draft.trim()]); setDraft(''); } }}>
      <textarea aria-label="消息" value={draft} onChange={event => setDraft(event.target.value)} placeholder="继续对话..." rows={2} />
      <div><span>工作区 / 发布准备</span><Button type="submit" size="icon" title="发送" aria-label="发送" disabled={!draft.trim()}><ArrowUp /></Button></div>
    </form>
  </div>;
}

const documents = [
  { name: '产品发布流程.md', detail: '发布规范 / 12 个片段', text: '发布前需完成变更审核、回归测试和负责人审批。' },
  { name: '回滚检查清单.md', detail: '运行手册 / 8 个片段', text: '确认数据兼容性、备份状态及回滚负责人。' },
  { name: '服务值班手册.md', detail: '团队知识 / 24 个片段', text: '异常发生后由值班负责人确认影响范围并跟进恢复。' },
];

function KnowledgePage({ searchOnly = false }: { searchOnly?: boolean }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const rows = documents.filter(doc => `${doc.name}${doc.text}`.includes(query));
  return <div className="prototype-page">
    <div className="prototype-page-title"><Database /><div><h2>{searchOnly ? '知识检索' : '知识库'}</h2><span>{searchOnly ? 'Search fixture' : 'StaffDeck Knowledge'}</span></div></div>
    {!searchOnly && <div className="prototype-stats"><div><strong>3</strong>文档</div><div><strong>44</strong>片段</div><div><strong>1</strong>已发布版本</div></div>}
    <label className="prototype-search"><Search /><Input aria-label="搜索知识库" placeholder="搜索文档或内容" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className={searchOnly ? 'prototype-search-results' : 'prototype-documents'}>
      {rows.map(doc => <button className="prototype-document" key={doc.name} onClick={() => setSelected(doc.name)}><FileText /><div><strong>{doc.name}</strong><span>{searchOnly ? doc.text : doc.detail}</span></div><ChevronRight /></button>)}
      {!rows.length && <p role="status">没有匹配的文档</p>}
    </div>
    {selected && <section className="prototype-document-detail"><Button variant="ghost" size="icon" aria-label="关闭文档" title="关闭文档" onClick={() => setSelected(null)}><X /></Button><h3>{selected}</h3><p>{documents.find(doc => doc.name === selected)?.text}</p></section>}
  </div>;
}

function SopPage() {
  const [status, setStatus] = useState('等待审批');
  return <div className="prototype-page"><div className="prototype-page-title"><Workflow /><div><h2>发布审批</h2><span>StaffDeck SOP / operator_approval</span></div></div>
    <ol className="prototype-workflow"><li><CheckCircle2 /><div><strong>准备变更</strong><span>变更说明已归档</span></div></li><li><CheckCircle2 /><div><strong>执行检查</strong><span>检查清单已生成</span></div></li><li><ShieldCheck /><div><strong>{status}</strong><span>发布负责人</span></div></li></ol>
    {status === '等待审批' && <div className="prototype-actions"><Button onClick={() => setStatus('审批已通过')}><Check />通过</Button><Button variant="outline" onClick={() => setStatus('已退回修改')}><X />退回</Button></div>}
    <p role="status">{status === '等待审批' ? '等待发布负责人确认。' : status}</p>
  </div>;
}

function SkillsPage() {
  const [active, setActive] = useState('release-check');
  return <div className="prototype-page"><div className="prototype-page-title"><Wrench /><div><h2>技能</h2><span>PilotDeck Skills</span></div></div>
    {['release-check', 'document-review', 'incident-summary'].map(name => <label className="prototype-setting" key={name}><div><strong>{name}</strong><span>工作区技能</span></div><input type="radio" name="skill" checked={active === name} onChange={() => setActive(name)} /></label>)}
  </div>;
}

function Setting({ label, value }: { label: string; value: string }) {
  const [current, setCurrent] = useState(value);
  return <label className="prototype-setting"><strong>{label}</strong><Input aria-label={label} value={current} onChange={event => setCurrent(event.target.value)} /></label>;
}

function SopWait() {
  const [approved, setApproved] = useState(false);
  return <div className="prototype-extension"><ShieldCheck /><div><strong>{approved ? '发布审批已确认' : '发布审批等待确认'}</strong><span>StaffDeck SOP</span></div><Button variant="outline" size="sm" disabled={approved} onClick={() => setApproved(true)}>{approved ? <Check /> : '确认'}</Button></div>;
}
function ToolTrace() {
  return <details className="prototype-trace"><summary>读取文件 · 产品发布流程.md</summary><p>发布流程共 3 个检查阶段，已读取完成。</p></details>;
}
function Citation() {
  return <details className="prototype-trace"><summary>知识引用 · 产品发布流程.md</summary><p>“发布前需完成变更审核、回归测试和负责人审批。”</p><small>StaffDeck Knowledge / published-v1</small></details>;
}

export const prototypeModules: FrontendModule[] = [
  { id: 'pilotdeck.chat', slot: 'agentLoop', contract: slotContracts.agentLoop,
    pages: [{ id: 'chat', path: '/chat', label: '对话', component: ChatPage }],
    settings: [{ id: 'agent', label: 'AgentLoop', component: () => <Setting label="执行模式" value="PilotDeck native" /> }] },
  { id: 'pilotdeck.skills', slot: 'skills', contract: slotContracts.skills,
    pages: [{ id: 'skills', path: '/skills', label: '技能', component: SkillsPage }],
    settings: [{ id: 'skills', label: 'Skills', component: () => <Setting label="技能来源" value="工作区" /> }] },
  { id: 'pilotdeck.tools', slot: 'tools', contract: slotContracts.tools,
    settings: [{ id: 'tools', label: 'Tools', component: () => <Setting label="工具审批" value="按需确认" /> }],
    toolRenderers: [{ id: 'read_file', label: '文件工具', component: ToolTrace }] },
  { id: 'pilotdeck.context', slot: 'context', contract: slotContracts.context,
    settings: [{ id: 'context', label: 'Context', component: () => <Setting label="上下文压缩" value="自动" /> }] },
  { id: 'pilotdeck.model', slot: 'modelProvider', contract: slotContracts.modelProvider,
    settings: [{ id: 'model', label: 'Model Provider', component: () => <Setting label="默认模型" value="provider1/qwen3.6-flash-distill" /> }] },
  { id: 'staffdeck.sop', slot: 'sop', contract: slotContracts.sop, requires: ['agentLoop', 'tools'],
    pages: [{ id: 'sop', path: '/sop', label: '流程', component: SopPage }],
    settings: [{ id: 'sop', label: 'SOP', component: () => <Setting label="默认流程" value="operator_approval" /> }],
    chatExtensions: [{ id: 'sop-wait', label: '流程审批', component: SopWait }] },
  { id: 'staffdeck.knowledge', slot: 'knowledge', contract: slotContracts.knowledge,
    pages: [{ id: 'knowledge', path: '/knowledge', label: '知识库', component: () => <KnowledgePage /> }],
    settings: [{ id: 'knowledge', label: 'Knowledge', component: () => <Setting label="知识版本" value="published-v1" /> }],
    artifactRenderers: [{ id: 'citation', label: '知识引用', component: Citation }] },
  { id: 'fixture.knowledge-search', slot: 'knowledge', contract: slotContracts.knowledge,
    pages: [{ id: 'knowledge-search', path: '/knowledge-search', label: '知识检索', component: () => <KnowledgePage searchOnly /> }],
    settings: [{ id: 'knowledge-search', label: 'Knowledge Search', component: () => <Setting label="检索结果上限" value="10" /> }],
    artifactRenderers: [{ id: 'citation', label: '知识引用', component: Citation }] },
];
