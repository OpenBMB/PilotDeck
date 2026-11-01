import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, List, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../utils/api';
import SkillMarkdown from './SkillMarkdown';

async function request<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await authenticatedFetch(`/api/skills/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export default function SkillReader({
  content,
  scope,
  slug,
  projectPath,
}: {
  content: string;
  scope: 'builtin' | 'user' | 'project';
  slug: string;
  projectPath: string | null;
}) {
  const { t } = useTranslation();
  const article = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState('SKILL.md');
  const [reference, setReference] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [outline, setOutline] = useState<{ id: string; text: string; level: number }[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const body = file === 'SKILL.md' ? content : reference;
  const scrollTo = (id: string) => {
    let decoded = id;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      /* Keep malformed anchors inert. */
    }
    const heading = Array.from(article.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(
      (node) => node.id === decoded,
    );
    heading?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  useEffect(() => {
    let cancelled = false;
    setListError(false);
    request<{ files: string[] }>('documents', { scope, slug, projectPath })
      .then((data) => {
        if (!cancelled) setFiles((data.files ?? []).filter((item) => item !== 'SKILL.md'));
      })
      .catch(() => {
        if (!cancelled) setListError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, slug, projectPath, retry]);
  useEffect(() => {
    setError(null);
    if (file === 'SKILL.md') {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setReference('');
    request<{ content: string }>('read-document', { scope, slug, projectPath, file })
      .then((data) => {
        if (!cancelled) setReference(data.content);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file, scope, slug, projectPath, retry]);
  useEffect(() => {
    setOutline(
      Array.from(article.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? []).map(
        (node) => ({
          id: node.id,
          text: node.textContent ?? '',
          level: Number(node.tagName.slice(1)),
        }),
      ),
    );
    if (!loading && !error && anchor) {
      scrollTo(anchor);
      setAnchor(null);
    }
  }, [body, loading, error, anchor]);
  const openReference = (href: string) => {
    try {
      const [pathname, hash] = href.split('#');
      if (!pathname) {
        scrollTo(hash ?? '');
        return;
      }
      const base = file.split('/').slice(0, -1);
      const segments = [...base, ...decodeURIComponent(pathname).split('/')];
      const resolved: string[] = [];
      for (const part of segments) {
        if (part === '..') {
          if (!resolved.length) throw new Error(t('skillsTab.referenceOutside'));
          resolved.pop();
        } else if (part && part !== '.') resolved.push(part);
      }
      if (pathname.startsWith('/') || /^(?:[a-z]+:|\\)/i.test(pathname))
        throw new Error(t('skillsTab.referenceOutside'));
      const nextFile = resolved.join('/');
      if (nextFile === file) {
        if (hash) scrollTo(hash);
        return;
      }
      setAnchor(hash ?? null);
      setFile(nextFile);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <div className="skills-reader-pane">
      <div className="skills-document-bar">
        {file !== 'SKILL.md' ? (
          <button
            type="button"
            className="skills-button"
            onClick={() => {
              setAnchor(null);
              setFile('SKILL.md');
              setError(null);
            }}
          >
            <ArrowLeft size={14} />
            {t('skillsTab.backToDocument')}
          </button>
        ) : null}
        <label className="skills-document-select">
          <span>{t('skillsTab.document')}</span>
          <select
            value={file}
            onChange={(event) => {
              setAnchor(null);
              setFile(event.target.value);
            }}
          >
            <option value="SKILL.md">SKILL.md</option>
            {Array.from(new Set([...files, ...(file !== 'SKILL.md' ? [file] : [])])).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        {file !== 'SKILL.md' ? <span className="skills-tag">{t('skillsTab.readOnly')}</span> : null}
        {listError ? (
          <button
            className="skills-icon-button"
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            aria-label={t('skillsTab.retryDocuments')}
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
      </div>
      <div className="skills-reader" ref={article}>
        {loading ? (
          <div className="skills-empty">
            <Loader2 className="animate-spin" size={18} />
            {t('skillsTab.loading')}
          </div>
        ) : error ? (
          <div role="alert" className="skills-inline-error">
            {error}
            <button
              type="button"
              className="skills-button"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('skillsTab.retry')}
            </button>
          </div>
        ) : (
          <>
            {outline.length > 1 ? (
              <details className="skills-outline">
                <summary>
                  <List size={14} />
                  {t('skillsTab.contents')}
                  <span>{outline.length}</span>
                </summary>
                <nav aria-label={t('skillsTab.contents')}>
                  {outline.map((heading) => (
                    <button
                      key={heading.id}
                      type="button"
                      style={{ paddingLeft: `${12 + (heading.level - 1) * 12}px` }}
                      onClick={() => scrollTo(heading.id)}
                    >
                      {heading.text}
                    </button>
                  ))}
                </nav>
              </details>
            ) : null}
            <SkillMarkdown content={body} onReference={openReference} onAnchor={scrollTo} />
          </>
        )}
      </div>
    </div>
  );
}
