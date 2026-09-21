import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowLeft, ChevronRight, Menu, MessageSquare, Settings, X } from 'lucide-react';
import { Button } from '../../shared/view/ui/Button';
import { assembleFrontend } from '../assemble';
import type { Assembly, Contribution } from '../contracts';
import { presets } from './profiles';
import { prototypeModules } from './modules';
import '../../index.css';
import './prototype.css';

function Contributions({ items }: { items: Contribution[] }) {
  return <>{items.map(({ id, component: Component }) => <Component key={id} sessionId="prototype-release" />)}</>;
}

function Workspace({ assembly }: { assembly: Assembly }) {
  const [route, setRoute] = useState('/chat');
  const [mobileOpen, setMobileOpen] = useState(false);
  const page = assembly.pages.find(item => item.path === route) ?? assembly.pages[0];
  const settings = route === '/settings';
  const navigate = (path: string) => { setRoute(path); setMobileOpen(false); };
  return <div className="prototype-workspace">
    <aside className={`prototype-sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <div className="prototype-brand"><img src="/pilotdeck-p-mark-compact.png" alt="" /><strong>PilotDeck</strong><Button className="prototype-mobile-close" variant="ghost" size="icon" title="关闭导航" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><X /></Button></div>
      <Button variant="outline" className="prototype-new-chat" onClick={() => navigate('/chat')}><MessageSquare />新对话</Button>
      <nav aria-label="模块导航">{assembly.pages.map(item => <button key={item.id} aria-current={!settings && page?.id === item.id ? 'page' : undefined} onClick={() => navigate(item.path)}><span>{item.label}</span><ChevronRight /></button>)}</nav>
      <div className="prototype-workspace-label">工作区</div><div className="prototype-project">发布准备<span>产品发布检查</span></div>
      <button className="prototype-settings-button" aria-current={settings ? 'page' : undefined} onClick={() => navigate('/settings')}><Settings />设置</button>
    </aside>
    <main className="prototype-main"><header><Button className="prototype-mobile-menu" variant="ghost" size="icon" aria-label="打开导航" title="打开导航" onClick={() => setMobileOpen(true)}><Menu /></Button><span>发布准备</span><ChevronRight /><strong>{settings ? '设置' : page?.label}</strong><span className="prototype-session-state">本地工作区</span></header>
      <div className="prototype-main-scroll">{settings ? <div className="prototype-page"><h2>设置</h2><Contributions items={assembly.settings} /></div> : page && <page.component sessionId="prototype-release">
        <div className="prototype-chat-contributions"><Contributions items={assembly.toolRenderers} /><Contributions items={assembly.artifactRenderers} /><Contributions items={assembly.chatExtensions} /></div>
      </page.component>}
      </div>
    </main>
  </div>;
}

function Prototype() {
  const [presetId, setPresetId] = useState(new URLSearchParams(location.search).get('profile') ?? 'staffdeck');
  const [inspect, setInspect] = useState(false);
  const preset = presets.find(item => item.id === presetId) ?? presets[0];
  let assembly: Assembly | undefined;
  let error = '';
  try { assembly = assembleFrontend(preset.profile, prototypeModules, preset.choices); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  return <div className="composition-prototype">
    <div className="prototype-devbar"><strong>组合预览</strong><label>Profile<select aria-label="组合 Profile" value={preset.id} onChange={event => { setPresetId(event.target.value); history.replaceState(null, '', `?profile=${event.target.value}`); }}>{presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><span className="prototype-mock">MOCK DATA</span><button aria-expanded={inspect} onClick={() => setInspect(!inspect)}>装配清单</button></div>
    {inspect && <section className="prototype-inspector" aria-label="装配清单"><p>仅原型数据；不连接 Gateway 或 StaffDeck 服务。</p>{assembly?.selections.map(({ slot, binding, frontend }) => <div key={slot}><code>{slot}</code><span>{binding.implementationId ?? binding.provider}</span><code>{frontend.id}</code></div>)}</section>}
    {assembly ? <Workspace key={preset.id} assembly={assembly} /> : <div role="alert" className="prototype-error"><AlertCircle /><h1>无法装配此组合</h1><p>{error}</p><Button variant="outline" onClick={() => setPresetId('staffdeck')}><ArrowLeft />返回可用组合</Button></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Prototype /></React.StrictMode>);
