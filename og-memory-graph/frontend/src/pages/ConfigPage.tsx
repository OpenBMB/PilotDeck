import { useEffect, useState } from 'react';
import type { ConfigField } from '../types';
import {
  fetchConfig, updateConfig, testConnection,
  fetchCustomProviders, addCustomProvider, updateCustomProvider,
  deleteCustomProvider, testCustomProvider,
  type CustomProvider } from
'../api/client';

const LLM_MODELS = [
'deepseek-v4-pro', 'deepseek-v4-flash',
'doubao-seed-2-0-pro-260215',
'qwen3-7b-plus', 'qwen-plus',
'gemini-2.5-pro', 'gpt-4o', 'gpt-4o-mini',
'claude-sonnet-4-5',
'MiniMax-M3'];


const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  qwen: 'Qwen（阿里云）',
  doubao: 'Doubao（火山方舟）',
  yeysai: 'YeySAI（聚合：Gemini / GPT-4o / Claude）'
};

const PROVIDER_ORDER = ['deepseek', 'minimax', 'qwen', 'doubao', 'yeysai'];

export default function ConfigPage() {
  const [fields, setFields] = useState<ConfigField[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const [testState, setTestState] = useState<Record<string, string>>({});


  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProv, setNewProv] = useState({ label: '', api_base: '', api_key: '', test_model: '' });
  const [editingProv, setEditingProv] = useState<CustomProvider | null>(null);

  const load = () => {
    fetchConfig().
    then((r) => setFields(r.fields)).
    catch((e) => setMsg(String(e)));
    fetchCustomProviders().then(setCustomProviders).catch(() => {});
  };
  useEffect(() => {load();}, []);

  const handleAddProvider = async () => {
    if (!newProv.label || !newProv.api_base) return;
    await addCustomProvider({ ...newProv, api_key: newProv.api_key || 'none', test_model: newProv.test_model || 'llama3' });
    setNewProv({ label: '', api_base: '', api_key: '', test_model: '' });
    setShowAddForm(false);
    fetchCustomProviders().then(setCustomProviders).catch(() => {});
  };

  const handleUpdateProvider = async () => {
    if (!editingProv) return;
    await updateCustomProvider(editingProv.id, editingProv);
    setEditingProv(null);
    fetchCustomProviders().then(setCustomProviders).catch(() => {});
  };

  const handleDeleteProvider = async (id: string) => {
    if (!confirm('确定删除此 provider？')) return;
    await deleteCustomProvider(id);
    fetchCustomProviders().then(setCustomProviders).catch(() => {});
  };

  const handleTestCustom = async (id: string) => {
    setTestState((prev) => ({ ...prev, [id]: '测试中…' }));
    const r = await testCustomProvider(id).catch((e) => ({ ok: false as const, error: String(e) }));
    setTestState((prev) => ({ ...prev, [id]: r.ok ? `✅ ${'latency_ms' in r ? r.latency_ms : ''}ms` : `❌ ${'error' in r ? r.error : ''}` }));
  };


  const byProvider: Record<string, ConfigField[]> = {};
  for (const f of fields) {
    if (!byProvider[f.provider]) byProvider[f.provider] = [];
    byProvider[f.provider].push(f);
  }

  const toggleEdit = (f: ConfigField) => {
    const next = !editing[f.key];
    setEditing((prev) => ({ ...prev, [f.key]: next }));
    if (next) {

      setEdits((prev) => ({ ...prev, [f.key]: f.masked && f.value.includes('***') ? '' : f.value }));
    }
  };

  const handleSave = async () => {
    setSaving(true);setMsg('');
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(edits)) {
      if (editing[k] && v !== '') updates[k] = v;
    }
    if (!Object.keys(updates).length) {setSaving(false);setMsg('没有修改项');return;}
    try {
      const r = await updateConfig(updates);
      setFields(r.fields);
      setEditing({});
      setEdits({});
      setMsg('✅ 已保存（重启后端后生效）');
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (provider: string) => {
    setTestState((prev) => ({ ...prev, [provider]: '测试中…' }));
    try {
      const r = await testConnection(provider);
      setTestState((prev) => ({
        ...prev,
        [provider]: r.ok ? `✅ ${r.latency_ms}ms` : `❌ ${r.error}`
      }));
    } catch (e: unknown) {
      setTestState((prev) => ({
        ...prev,
        [provider]: `❌ ${e instanceof Error ? e.message : String(e)}`
      }));
    }
  };

  const hasEdits = Object.values(editing).some(Boolean);


  const [cfgTab, setCfgTab] = useState<'builtin' | 'custom' | 'models'>('builtin');

  return (
    <div className="config-page">
      <div className="detail-hd">
        <div className="breadcrumb">⚙ 配置</div>
        <h2 style={{ marginTop: 8 }}>系统配置</h2>
        <div className="tabs" style={{ marginTop: 12 }}>
          <button className={`tab${cfgTab === 'builtin' ? ' on' : ''}`} onClick={() => setCfgTab('builtin')}>内置 API</button>
          <button className={`tab${cfgTab === 'custom' ? ' on' : ''}`} onClick={() => setCfgTab('custom')}>自定义 Provider</button>
          <button className={`tab${cfgTab === 'models' ? ' on' : ''}`} onClick={() => setCfgTab('models')}>默认模型</button>
        </div>
      </div>

      <div className="config-body">

        {}
        {cfgTab === 'builtin' && PROVIDER_ORDER.map((prov) => {
          const pFields = byProvider[prov] ?? [];
          if (!pFields.length) return null;
          const testStatus = testState[prov];
          return (
            <section key={prov} className="config-section">
              <div className="config-prov-hd">
                <h3 className="config-sec-hd" style={{ margin: 0 }}>
                  {PROVIDER_LABELS[prov] ?? prov}
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {testStatus &&
                  <span className={`test-badge${testStatus.startsWith('✅') ? ' ok' : testStatus === '测试中…' ? ' pending' : ' fail'}`}>
                      {testStatus}
                    </span>
                  }
                  <button className="btn-ghost btn-sm"
                  onClick={() => handleTest(prov)}
                  disabled={testStatus === '测试中…'}>
                    🔌 测试连通性
                  </button>
                </div>
              </div>

              {pFields.map((f) =>
              <div key={f.key} className="config-row">
                  <span className="config-label">{f.label}</span>
                  {editing[f.key] ?
                <input
                  className="form-input config-val-input"
                  placeholder={f.masked ? '输入新的 Key…' : '输入新的 Base URL…'}
                  value={edits[f.key] ?? ''}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  autoFocus={f.masked} /> :

                <code className="config-val">{f.value || '（未配置）'}</code>
                }
                  <button className="btn-ghost btn-sm" onClick={() => toggleEdit(f)}>
                    {editing[f.key] ? '取消' : '✏️'}
                  </button>
                </div>
              )}
            </section>);

        })}

        {}
        {cfgTab === 'models' && (byProvider['llm'] ?? []).length > 0 &&
        <section className="config-section">
            <h3 className="config-sec-hd">默认模型</h3>
            {(byProvider['llm'] ?? []).map((f) =>
          <div key={f.key} className="config-row">
                <span className="config-label">{f.label}</span>
                {editing[f.key] ?
            <select
              className="form-sel config-val-input"
              value={edits[f.key] ?? f.value}
              onChange={(e) => setEdits((prev) => ({ ...prev, [f.key]: e.target.value }))}>
              
                      {LLM_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select> :
            <code className="config-val">{f.value}</code>
            }
                <button className="btn-ghost btn-sm"
            onClick={() => {
              if (!editing[f.key]) setEdits((prev) => ({ ...prev, [f.key]: f.value }));
              setEditing((prev) => ({ ...prev, [f.key]: !prev[f.key] }));
            }}>
                  {editing[f.key] ? '取消' : '✏️'}
                </button>
              </div>
          )}
          </section>
        }

        {}
        {cfgTab !== 'custom' &&
        <>
            {msg && <div className="form-err" style={{ marginTop: 12 }}>{msg}</div>}
            <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button className="btn-primary" onClick={handleSave} disabled={saving || !hasEdits}>
                {saving ? '保存中…' : '保存配置'}
              </button>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>修改后需重启后端才能生效</span>
            </div>
          </>
        }

        {}
        {cfgTab === 'custom' &&
        <section className="config-section" style={{ marginTop: 0 }}>
          <div className="config-prov-hd">
            <h3 className="config-sec-hd" style={{ margin: 0 }}>自定义 Provider（本地 LLM / 其他端点）</h3>
            <button className="btn-ghost btn-sm" onClick={() => setShowAddForm((o) => !o)}>
              {showAddForm ? '▲ 收起' : '＋ 新增'}
            </button>
          </div>

          {showAddForm &&
          <div className="custom-prov-form">
              {[
            ['名称', 'label', '如 My Local LLM'],
            ['API Base', 'api_base', 'http://localhost:8000/v1'],
            ['API Key', 'api_key', '无需 key 时填 none'],
            ['测试模型名', 'test_model', '如 llama3, qwen2.5']].
            map(([label, key, placeholder]) =>
            <label key={key} className="form-row" style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: '#475569', width: 80 }}>{label}</span>
                  <input className="form-input" style={{ flex: 1 }} placeholder={placeholder}
              value={(newProv as Record<string, string>)[key] || ''}
              onChange={(e) => setNewProv((prev) => ({ ...prev, [key]: e.target.value }))} />
                </label>
            )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary btn-sm" onClick={handleAddProvider}
              disabled={!newProv.label || !newProv.api_base}>保存</button>
                <button className="btn-ghost btn-sm" onClick={() => setShowAddForm(false)}>取消</button>
              </div>
            </div>
          }

          {customProviders.map((p) =>
          <div key={p.id} className="config-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '12px 0' }}>
              {editingProv?.id === p.id ?
            <div className="custom-prov-form">
                  {[
              ['名称', 'label'], ['API Base', 'api_base'],
              ['API Key', 'api_key'], ['测试模型名', 'test_model']].
              map(([label, key]) =>
              <label key={key} className="form-row" style={{ marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: '#475569', width: 80 }}>{label}</span>
                      <input className="form-input" style={{ flex: 1 }}
                value={(editingProv as unknown as Record<string, string>)[key] || ''}
                onChange={(e) => setEditingProv((prev) => prev ? { ...prev, [key]: e.target.value } : null)} />
                    </label>
              )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-primary btn-sm" onClick={handleUpdateProvider}>保存</button>
                    <button className="btn-ghost btn-sm" onClick={() => setEditingProv(null)}>取消</button>
                  </div>
                </div> :

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
                  <code className="config-val" style={{ flex: 1 }}>{p.api_base}</code>
                  {testState[p.id] &&
              <span className={`test-badge${testState[p.id].startsWith('✅') ? ' ok' : testState[p.id] === '测试中…' ? ' pending' : ' fail'}`}>
                      {testState[p.id]}
                    </span>
              }
                  <button className="btn-ghost btn-sm" onClick={() => handleTestCustom(p.id)}
              disabled={testState[p.id] === '测试中…'}>🔌 测试</button>
                  <button className="btn-ghost btn-sm" onClick={() => setEditingProv(p)}>✏️</button>
                  <button className="btn-ghost btn-sm" style={{ color: '#ef4444' }}
              onClick={() => handleDeleteProvider(p.id)}>🗑</button>
                </div>
            }
            </div>
          )}

          {customProviders.length === 0 && !showAddForm &&
          <div style={{ fontSize: 12, color: '#94a3b8', padding: '12px 0' }}>
              暂无自定义 Provider。点上方「＋ 新增」添加本地 LLM 或其他自定义端点。
            </div>
          }
        </section>
        }  {}
      </div>
    </div>);

}
