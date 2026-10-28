import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebSearchCustomProviderConfig } from '../../../../../../../src/pilot/config/webSearchConfig.js';
import { customSearchRequest, validateCustomSearch } from '../../../../../../../src/pilot/config/customSearch.js';
import { CUSTOM_SEARCH_PRESETS, customSearchPreset } from '../../../../../../../src/pilot/config/customSearchPresets.js';
import './CustomSearchEditor.css';

export default function CustomSearchEditor({ value, endpoint, disabled, onSave }: {
  value: WebSearchCustomProviderConfig; endpoint: string; disabled: boolean;
  onSave: (value: WebSearchCustomProviderConfig, endpoint: string) => void;
}) {
  const { t } = useTranslation('settings');
  const label = (key: string) => t(`customSearch.${key}`);
  const [draft, setDraft] = useState(value);
  const [url, setUrl] = useState(endpoint);
  const jsonText = (value: unknown) => value === undefined ? '' : JSON.stringify(value, null, 2);
  const [headers, setHeaders] = useState(jsonText(value.headers));
  const [params, setParams] = useState(jsonText(value.queryParams));
  const [body, setBody] = useState(jsonText(value.requestBody));
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const [query, setQuery] = useState('PilotDeck');
  const change = (patch: Partial<WebSearchCustomProviderConfig>) => { setDraft({ ...draft, ...patch }); setError(''); setPreview(''); };
  const prepare = () => {
    const parse = (text: string, field: string) => { try { return text.trim() ? JSON.parse(text) : undefined; } catch { throw new Error(label('invalidJson') + ': ' + field); } };
    const config = { ...draft, headers: parse(headers, label('headers')), queryParams: parse(params, label('queryParams')), requestBody: parse(body, label('requestBody')) };
    validateCustomSearch(config);
    return config;
  };
  const run = (save: boolean) => {
    try {
      const config = prepare();
      const request = customSearchRequest(url, config, { query, gl: 'us', limit: 3, apiKey: '[API_KEY]' });
      setError('');
      if (save) { onSave(config, url.trim()); setPreview(''); }
      else setPreview(JSON.stringify(request, null, 2));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setPreview(''); }
  };
  const field = (key: 'name' | 'queryParam' | 'apiKeyParam' | 'resultsPath' | 'titleField' | 'urlField' | 'snippetField' | 'sourceField' | 'publishedAtField', placeholder: string) => <label key={key}>{label(key)}
    <input value={draft[key] ?? ''} placeholder={placeholder} onChange={event => change({ [key]: event.target.value })} />
  </label>;
  return <fieldset className="custom-search-editor" disabled={disabled}>
    <legend>{label('title')}</legend>
    <p>{label('description')}</p>
    <label>{label('preset')}<select defaultValue="" onChange={event => {
      const id = event.target.value as typeof CUSTOM_SEARCH_PRESETS[number];
      if (!CUSTOM_SEARCH_PRESETS.includes(id)) return;
      const preset = customSearchPreset(id); setDraft(preset.customProvider); if (preset.endpoint) setUrl(preset.endpoint);
      setHeaders(jsonText(preset.customProvider.headers)); setParams(jsonText(preset.customProvider.queryParams)); setBody(jsonText(preset.customProvider.requestBody)); setError(''); setPreview('');
    }}><option value="">{label('choosePreset')}</option>{CUSTOM_SEARCH_PRESETS.map(id => <option key={id} value={id}>{id === 'searxng' ? 'SearXNG' : id === 'openwebui' ? 'Open WebUI External' : t(`pilotDeckConfig.panels.tools.provider.${id}`)}</option>)}</select></label>
    <div className="custom-search-grid">
      {field('name', 'Custom search')}
      <label>{label('endpoint')}<input type="url" value={url} onChange={event => setUrl(event.target.value)} /></label>
      <label>{label('method')}<select value={draft.method ?? 'POST'} onChange={event => change({ method: event.target.value as 'GET' | 'POST' })}><option>GET</option><option>POST</option></select></label>
      <label>{label('auth')}<select value={draft.auth ?? 'bearer'} onChange={event => change({ auth: event.target.value as WebSearchCustomProviderConfig['auth'] })}>{['bearer', 'headerApiKey', 'bodyApiKey', 'queryApiKey', 'none'].map(auth => <option key={auth} value={auth}>{label(`authOptions.${auth}`)}</option>)}</select></label>
      {field('apiKeyParam', 'api_key')}{field('queryParam', 'query')}
    </div>
    <p>{label('variables')}</p><p>{label('legacy')}</p>
    <label>{label('headers')}<textarea rows={3} value={headers} placeholder={'{"X-API-Key":"{{apiKey}}"}'} onChange={event => setHeaders(event.target.value)} /></label>
    <label>{label('queryParams')}<textarea rows={3} value={params} placeholder={'{"q":"{{query}}","count":"{{limit}}"}'} onChange={event => setParams(event.target.value)} /></label>
    <label>{label('bodyEncoding')}<select value={draft.bodyEncoding ?? 'json'} onChange={event => change({ bodyEncoding: event.target.value as 'json' | 'form' })}><option value="json">JSON</option><option value="form">application/x-www-form-urlencoded</option></select></label>
    <label>{label('requestBody')}<textarea rows={7} value={body} placeholder={'{"messages":[{"role":"user","content":"{{query}}"}],"count":"{{limit}}"}'} onChange={event => setBody(event.target.value)} /></label>
    <h4>{label('mapping')}</h4><p>{label('paths')}</p>
    <div className="custom-search-grid">{field('resultsPath', 'data.results')}{field('titleField', 'title')}{field('urlField', 'url')}{field('snippetField', 'snippet')}{field('sourceField', 'source')}{field('publishedAtField', 'publishedAt')}</div>
    <label>{label('testQuery')}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="custom-search-actions"><button type="button" className="test-button" onClick={() => run(false)}>{label('preview')}</button><button type="button" className="test-button" onClick={() => run(true)}>{label('save')}</button></div>
    {error && <p role="alert">{error}</p>}{preview && <pre aria-label={label('preview')}>{preview}</pre>}
  </fieldset>;
}
