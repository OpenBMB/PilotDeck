import { useState } from 'react';
import { Braces, ChevronDown, Eye, ListFilter, Save, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WebSearchCustomProviderConfig } from '../../../../../../../src/pilot/config/webSearchConfig.js';
import { customSearchRequest, validateCustomSearch } from '../../../../../../../src/pilot/config/customSearch.js';
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
      else {
        const body = request.init.body;
        // Present HTTP content rather than a JSON-encoded Fetch RequestInit.
        // The actual adapter keeps the serialized body used on the wire.
        setPreview(JSON.stringify({
          method: request.init.method, url: request.url, headers: request.init.headers,
          ...(body === undefined ? {} : { body: new Headers(request.init.headers).get('content-type') === 'application/json' ? JSON.parse(body) : body }),
        }, null, 2));
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setPreview(''); }
  };
  const field = (key: 'name' | 'queryParam' | 'apiKeyParam' | 'resultsPath' | 'titleField' | 'urlField' | 'snippetField' | 'sourceField' | 'publishedAtField', placeholder: string) => <label key={key}><span>{label(key)}</span>
    <input value={draft[key] ?? ''} placeholder={placeholder} onChange={event => change({ [key]: event.target.value })} />
  </label>;
  return <fieldset className="custom-search-editor" disabled={disabled}>
    <legend className="sr-only">{label('title')}</legend>
    <header className="custom-search-heading">
      <h3>{label('title')}</h3>
      <p>{label('description')}</p>
    </header>
    <section className="custom-search-section">
      <h4><Settings2 aria-hidden="true" />{label('basicsTitle')}</h4>
      <div className="custom-search-grid">
        {field('name', label('namePlaceholder'))}
        <label><span>{label('endpoint')}</span><input type="url" value={url} onChange={event => setUrl(event.target.value)} /></label>
        <label><span>{label('method')}</span><div className="custom-search-select"><select value={draft.method ?? 'POST'} onChange={event => change({ method: event.target.value as 'GET' | 'POST' })}><option>GET</option><option>POST</option></select><ChevronDown aria-hidden="true" /></div></label>
        <label><span>{label('auth')}</span><div className="custom-search-select"><select value={draft.auth ?? 'bearer'} onChange={event => change({ auth: event.target.value as WebSearchCustomProviderConfig['auth'] })}>{['bearer', 'headerApiKey', 'bodyApiKey', 'queryApiKey', 'none'].map(auth => <option key={auth} value={auth}>{label('authOptions.' + auth)}</option>)}</select><ChevronDown aria-hidden="true" /></div></label>
        {field('apiKeyParam', 'api_key')}{field('queryParam', 'query')}
      </div>
    </section>
    <section className="custom-search-section">
      <h4><Braces aria-hidden="true" />{label('requestTitle')}</h4>
      <details className="custom-search-help">
        <summary>{label('variablesHelp')}</summary>
        <p>{label('variables')}</p><p>{label('legacy')}</p>
      </details>
      <div className="custom-search-grid">
        <label><span>{label('headers')}</span><textarea rows={4} spellCheck={false} value={headers} placeholder={'{\n  "X-API-Key": "{{apiKey}}"\n}'} onChange={event => setHeaders(event.target.value)} /></label>
        <label><span>{label('queryParams')}</span><textarea rows={4} spellCheck={false} value={params} placeholder={'{\n  "q": "{{query}}",\n  "count": "{{limit}}"\n}'} onChange={event => setParams(event.target.value)} /></label>
        <label><span>{label('bodyEncoding')}</span><div className="custom-search-select"><select value={draft.bodyEncoding ?? 'json'} onChange={event => change({ bodyEncoding: event.target.value as 'json' | 'form' })}><option value="json">JSON</option><option value="form">{label('formEncoding')}</option></select><ChevronDown aria-hidden="true" /></div></label>
        <label className="custom-search-wide"><span>{label('requestBody')}</span><textarea rows={7} spellCheck={false} value={body} placeholder={'{\n  "messages": [{ "role": "user", "content": "{{query}}" }],\n  "count": "{{limit}}"\n}'} onChange={event => setBody(event.target.value)} /></label>
      </div>
    </section>
    <section className="custom-search-section">
      <h4><ListFilter aria-hidden="true" />{label('mapping')}</h4>
      <p>{label('paths')}</p>
      <div className="custom-search-grid">{field('resultsPath', 'data.results')}{field('titleField', 'title')}{field('urlField', 'url')}{field('snippetField', 'snippet')}{field('sourceField', 'source')}{field('publishedAtField', 'publishedAt')}</div>
    </section>
    <section className="custom-search-section custom-search-preview">
      <h4><Eye aria-hidden="true" />{label('previewTitle')}</h4>
      <div className="custom-search-preview-controls">
        <label><span>{label('testQuery')}</span><input value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="custom-search-actions">
          <button type="button" onClick={() => run(false)}><Eye aria-hidden="true" />{label('preview')}</button>
          <button type="button" className="custom-search-save" onClick={() => run(true)}><Save aria-hidden="true" />{label('save')}</button>
        </div>
      </div>
      {error && <p className="custom-search-error" role="alert">{error}</p>}
      {preview && <>
        <p>{label('previewHint')}</p>
        <pre aria-label={label('preview')}>{preview}</pre>
      </>}
    </section>
  </fieldset>;
}
