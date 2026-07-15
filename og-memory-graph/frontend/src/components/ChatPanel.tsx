import { useEffect, useRef, useState } from 'react';
import {
  fetchConversations, createConversation, fetchConversation,
  deleteConversation, clearConversationMessages, streamChatMessage,
  type ConvMeta, type ConvFull, type ConvMessage } from
'../api/client';
import { useModel } from '../context/ModelContext';
import { usePreferences } from '../context/PreferenceContext';
import ChatMessage from './ChatMessage';

interface Props {
  clusterId?: string;
  tab?: string;
  version?: string;
  onClose: () => void;
  onNavigate?: (detail: Record<string, unknown>) => void;
}

export default function ChatPanel({ clusterId, tab, version, onClose, onNavigate }: Props) {
  const { model } = useModel();
  const { prefs, update } = usePreferences();


  const [convList, setConvList] = useState<ConvMeta[]>([]);
  const [conv, setConv] = useState<ConvFull | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamMsg, setStreamMsg] = useState('');
  const [streamTools, setStreamTools] = useState<ConvMessage['tool_events']>([]);
  const [error, setError] = useState('');


  const [showCfg, setShowCfg] = useState(false);


  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragOrigin = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });


  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragging.current = true;
    dragOrigin.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragOrigin.current.mx;
      const dy = e.clientY - dragOrigin.current.my;
      setPos({ x: dragOrigin.current.px + dx, y: dragOrigin.current.py + dy });
    };
    const onUp = () => {dragging.current = false;};
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {window.removeEventListener('mousemove', onMove);window.removeEventListener('mouseup', onUp);};
  }, []);


  const loadList = () => {
    fetchConversations(clusterId).then((r) => setConvList(r.conversations)).catch(() => {});
  };
  useEffect(() => {loadList();}, [clusterId]);

  const selectConv = async (id: string) => {
    const c = await fetchConversation(id).catch(() => null);
    if (c) {setConv(c);setTimeout(scrollToBottom, 100);}
  };

  const newConv = async () => {
    const chatModel = prefs.chat_model || 'deepseek-v4-pro';
    const c = await createConversation(clusterId, chatModel).catch(() => null);
    if (c) {setConv(c);loadList();inputRef.current?.focus();}
  };

  const deleteConv = async (id: string) => {
    await deleteConversation(id).catch(() => {});
    if (conv?.id === id) setConv(null);
    loadList();
  };

  const clearConv = async () => {
    if (!conv) return;
    await clearConversationMessages(conv.id).catch(() => {});
    setConv((prev) => prev ? { ...prev, messages: [], title: '' } : null);
  };


  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');setError('');

    let activeConv = conv;
    if (!activeConv) {
      const chatModel = prefs.chat_model || 'deepseek-v4-pro';
      activeConv = await createConversation(clusterId, chatModel).catch(() => null);
      if (!activeConv) {setError('新建会话失败');return;}
      setConv(activeConv);loadList();
    }

    const userMsg: ConvMessage = { role: 'user', content: text, ts: new Date().toISOString() };
    setConv((prev) => prev ? { ...prev, messages: [...prev.messages, userMsg] } : null);
    setTimeout(scrollToBottom, 50);

    setStreaming(true);setStreamMsg('');setStreamTools([]);

    const ctx = { cluster_id: clusterId, model, tab, version };
    try {
      for await (const ev of streamChatMessage(activeConv.id, text, ctx)) {
        if (ev.type === 'text') {
          setStreamMsg((prev) => prev + (ev.delta as string || ''));
          setTimeout(scrollToBottom, 20);
        } else if (ev.type === 'navigate') {

          onNavigate?.(ev as Record<string, unknown>);
        } else if (ev.type === 'tool_call') {
          setStreamTools((prev) => [...(prev ?? []), { type: 'tool_call', name: ev.name as string, input: ev.input }]);
        } else if (ev.type === 'tool_result') {
          setStreamTools((prev) => [...(prev ?? []), { type: 'tool_result', name: ev.name as string, result: ev.result }]);
        } else if (ev.type === 'done') {
          break;
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '发送失败');
    }

    setStreaming(false);setStreamMsg('');setStreamTools([]);
    const updated = await fetchConversation(activeConv.id).catch(() => null);
    if (updated) {setConv(updated);loadList();}
    setTimeout(scrollToBottom, 100);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {e.preventDefault();handleSend();}
  };

  const streamingPreviewMsg: ConvMessage | null = streaming ?
  { role: 'assistant', content: streamMsg, ts: '', tool_events: streamTools } :
  null;


  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    right: `calc(20px - ${pos.x}px)`,
    bottom: `calc(20px - ${pos.y}px)`,
    width: 560,
    height: '82vh',
    maxWidth: 'calc(100vw - 40px)',
    maxHeight: 'calc(100vh - 40px)'
  };

  return (
    <div ref={panelRef} className="chat-panel" style={panelStyle}>
      {}
      <div className="chat-header" onMouseDown={handleHeaderMouseDown}
      style={{ cursor: 'grab', userSelect: 'none' }}>
        <span className="chat-title">💬 研究助手</span>
        {clusterId && <span className="chat-ctx">{clusterId}{tab ? ` · ${tab}` : ''}</span>}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button className="btn-ghost btn-sm" onClick={newConv} title="新对话">＋</button>
          {conv && <button className="btn-ghost btn-sm" onClick={clearConv} title="清空">🗑</button>}
          <button className="btn-ghost btn-sm" onClick={() => setShowCfg((o) => !o)} title="设置">⚙</button>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
      </div>

      {}
      {showCfg &&
      <div className="chat-cfg-panel">
          <div className="chat-cfg-title">助手设置</div>
          <label className="form-row-h" style={{ gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 60, color: '#64748b' }}>对话模型</span>
            <select className="form-sel" style={{ flex: 1, fontSize: 12 }}
          value={prefs.chat_model || 'deepseek-v4-pro'}
          onChange={(e) => update('chat_model', e.target.value)}>
              {['deepseek-v4-pro', 'deepseek-v4-flash', 'doubao-seed-2-0-pro-260215',
            'qwen3-7b-plus', 'gemini-2.5-pro', 'gpt-4o', 'claude-sonnet-4-5', 'MiniMax-M3'].
            map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="form-row-h" style={{ gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 60, color: '#64748b' }}>专业程度</span>
            <select className="form-sel" style={{ flex: 1, fontSize: 12 }}
          value={prefs.expertise_level || 'researcher'}
          onChange={(e) => update('expertise_level', e.target.value)}>
              <option value="beginner">入门（通俗解释）</option>
              <option value="researcher">研究员（专业简洁）</option>
              <option value="expert">专家（省略基础）</option>
            </select>
          </label>
          <label className="form-row-h" style={{ gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 60, color: '#64748b' }}>回复语言</span>
            <select className="form-sel" style={{ flex: 1, fontSize: 12 }}
          value={prefs.response_language || 'zh'}
          onChange={(e) => update('response_language', e.target.value)}>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>设置实时生效，下次对话起使用</div>
        </div>
      }

      {}
      {convList.length > 0 &&
      <div className="chat-conv-list">
          {convList.slice(0, 6).map((c) =>
        <div key={c.id}
        className={`chat-conv-item${conv?.id === c.id ? ' on' : ''}`}
        onClick={() => selectConv(c.id)}>
              <span className="chat-conv-title">{c.title || '新对话'}</span>
              <button className="icon-btn" style={{ fontSize: 11 }}
          onClick={(e) => {e.stopPropagation();deleteConv(c.id);}}>×</button>
            </div>
        )}
        </div>
      }

      {}
      <div className="chat-messages">
        {!conv &&
        <div className="chat-welcome">
            <div style={{ fontSize: 36 }}>🤖</div>
            <div style={{ fontWeight: 600 }}>og 研究助手</div>
            <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>
              分析图谱、对比报告、启动流水线<br />测试 API 连通性、管理参考文献…
            </div>
            <button className="btn-primary" style={{ marginTop: 16 }} onClick={newConv}>开始对话</button>
          </div>
        }
        {conv?.messages.map((msg, i) => <ChatMessage key={i} msg={msg} />)}
        {streamingPreviewMsg && <ChatMessage msg={streamingPreviewMsg} isStreaming={streaming} />}
        {error && <div className="chat-error">{error}</div>}
        <div ref={messagesEndRef} />
      </div>

      {}
      <div className="chat-input-area">
        <textarea ref={inputRef} className="chat-input"
        placeholder="输入消息… (Enter 发送，Shift+Enter 换行)"
        value={input} onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown} disabled={streaming} rows={3} />
        <button className="btn-primary chat-send" onClick={handleSend}
        disabled={streaming || !input.trim()}>
          {streaming ? '…' : '↑'}
        </button>
      </div>
    </div>);

}
