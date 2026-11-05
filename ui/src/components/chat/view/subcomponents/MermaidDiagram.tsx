import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { parse as parseYaml } from 'yaml';
import { useTheme } from '../../../../contexts/ThemeContext';

const MAX_DIAGRAM_LENGTH = 50_000;
let renderer: Promise<typeof import('mermaid')> | undefined;
let pending: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;

/** Serialize initialization and rendering: Mermaid's theme configuration is global. */
function renderMermaid(source: string, dark: boolean): Promise<string> {
  if (source.length > MAX_DIAGRAM_LENGTH) return Promise.reject(new Error('Diagram is too large'));
  const result = pending.then(async () => {
    renderer ??= import('mermaid').catch(error => {
      renderer = undefined;
      throw error;
    });
    const { default: mermaid } = await renderer;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: dark ? 'dark' : 'default',
      themeCSS: '',
      fontFamily: 'Inter, sans-serif',
      maxTextSize: MAX_DIAGRAM_LENGTH,
      maxEdges: 500,
      suppressErrorRendering: true,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
        'htmlLabels', 'theme', 'themeCSS', 'fontFamily', 'dompurifyConfig'],
    });
    // Inspect the diagram body, not YAML frontmatter or init directives.
    const diagramText = source.trimStart()
      .replace(/^---\s*[\n\r].*?[\n\r]---\s*[\n\r]+/s, '')
      .replace(/%%\{[\s\S]*?\}%%/g, '');
    if (mermaid.detectType(diagramText).startsWith('flowchart')) {
      // Flowchart image nodes await network I/O inside Mermaid's global queue.
      // Inspect their YAML attributes; skip comments, labels and accessibility text.
      for (const match of diagramText.matchAll(/%%[^\n]*|\bacc(?:Title|Descr)\s*:[^\n]*|\baccDescr\s*\{[^}]*\}|"[^"]*"|@\{((?:"[^"]*"|[^"}])*)\}/g)) {
        if (match[1] === undefined) continue;
        // Mermaid turns line breaks within quoted labels into <br/> first.
        const metadata = match[1].replace(/"[^"]*"/g, value => value.replace(/\n\s*/g, '<br/>'));
        const attributes = parseYaml(metadata.includes('\n') ? metadata : `{${metadata}}`);
        if (attributes?.img && !/^data:/i.test(String(attributes.img).trim())) {
          throw new Error('External images are not supported in diagrams');
        }
      }
    }
    // Mermaid measures text in the document. Own its temporary DOM so a parse
    // failure cannot leave an error graphic outside the chat message.
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;top:0;left:0';
    document.body.append(container);
    try {
      // Unlike crypto.randomUUID(), these DOM ids also work on HTTP LAN deployments.
      const id = `mermaid-${Date.now()}-${++nextDiagramId}`;
      const { svg } = await mermaid.render(id, source, container);
      return svg;
    } finally {
      container.remove();
    }
  });
  pending = result.catch(() => undefined);
  return result;
}

export function MermaidDiagram({ source, hidden, fallback }: {
  source: string;
  hidden: boolean;
  fallback: ReactNode;
}) {
  const { t } = useTranslation('chat');
  const { isDarkMode: dark } = useTheme() as { isDarkMode: boolean };
  const [result, setResult] = useState<{ source: string; dark: boolean; svg?: string }>();

  useEffect(() => {
    let active = true;
    void renderMermaid(source, dark).then(
      svg => { if (active) setResult({ source, dark, svg }); },
      () => { if (active) setResult({ source, dark }); },
    );
    return () => { active = false; };
  }, [source, dark]);

  const current = result?.source === source && result.dark === dark ? result : undefined;
  return (
    <div hidden={hidden} data-chat-search-text={!current || current.svg ? source : undefined}>
      {!current ? (
        <p role="status" className="px-4 pb-4 text-sm">{t('mermaid.loading', { defaultValue: 'Rendering diagram…' })}</p>
      ) : current.svg ? (
        <div role="img" aria-label={t('mermaid.preview', { defaultValue: 'Mermaid diagram' })}
          className="mermaid-diagram overflow-x-auto p-4" dangerouslySetInnerHTML={{ __html: current.svg }} />
      ) : (
        <>
          <p role="status" data-chat-search-text="" className="px-4 pb-2 text-sm">{t('mermaid.failed', { defaultValue: 'Unable to render this diagram. The source is shown below.' })}</p>
          {fallback}
        </>
      )}
    </div>
  );
}
