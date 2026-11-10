import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    if (diagram.type.startsWith('flowchart')) {
      // Flowchart image nodes await network I/O inside Mermaid's global queue.
      // Inspect parsed nodes so comments and normalized labels follow Mermaid's grammar.
      const vertices = (diagram.db as { getVertices(): Map<string, { img?: string }> }).getVertices();
      for (const vertex of vertices.values()) {
        if (vertex.img && !/^data:/i.test(String(vertex.img).trim())) {
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
