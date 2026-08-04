import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { search } from '@codemirror/search';
import { zincDarkTheme, zincLightTheme } from '../../utils/zincThemes';
import HtmlDocumentPreview from './HtmlDocumentPreview';
import MarkdownPreview from './markdown/MarkdownPreview';

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  markdownPreview: boolean;
  isMarkdownFile: boolean;
  htmlPreview?: boolean;
  isHtmlFile?: boolean;
  htmlPreviewUrl?: string | null;
  fileName?: string;
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
  baseFilePath?: string;
  onFileOpen?: (filePath: string) => void;
  previewRootRef?: RefObject<HTMLDivElement>;
  onEditorViewChange?: (view: EditorView | null) => void;
};

export default function CodeEditorSurface({
  content,
  onChange,
  markdownPreview,
  isMarkdownFile,
  htmlPreview = false,
  isHtmlFile = false,
  htmlPreviewUrl = null,
  fileName = '',
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
  baseFilePath,
  onFileOpen,
  previewRootRef,
  onEditorViewChange,
}: CodeEditorSurfaceProps) {
  const createdEditorViewRef = useRef<EditorView | null>(null);
  const searchExtension = useMemo(() => search({ top: true }), []);
  const resolvedExtensions = useMemo(
    () => [searchExtension, ...extensions],
    [extensions, searchExtension],
  );
  const previewActive = (htmlPreview && isHtmlFile) || (markdownPreview && isMarkdownFile);

  useEffect(() => {
    if (!previewActive || !createdEditorViewRef.current) return;
    createdEditorViewRef.current = null;
    onEditorViewChange?.(null);
  }, [onEditorViewChange, previewActive]);

  useEffect(() => () => {
    createdEditorViewRef.current = null;
    onEditorViewChange?.(null);
  }, [onEditorViewChange]);

  if (htmlPreview && isHtmlFile && htmlPreviewUrl) {
    return <HtmlDocumentPreview url={htmlPreviewUrl} title={`Preview: ${fileName}`} />;
  }

  if (markdownPreview && isMarkdownFile) {
    return (
      <div
        ref={previewRootRef}
        className="h-full overflow-y-auto bg-white dark:bg-neutral-950"
      >
        <div className="prose prose-sm prose-neutral mx-auto max-w-none px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-neutral-900 prose-a:underline prose-code:text-[13px] prose-pre:bg-neutral-900 prose-img:rounded-lg dark:prose-a:text-neutral-100">
          <MarkdownPreview content={content} baseFilePath={baseFilePath} onFileOpen={onFileOpen} />
        </div>
      </div>
    );
  }

  return (
    <CodeMirror
      value={content}
      onChange={onChange}
      extensions={resolvedExtensions}
      onCreateEditor={(view) => {
        createdEditorViewRef.current = view;
        onEditorViewChange?.(view);
      }}
      theme={isDarkMode ? zincDarkTheme : zincLightTheme}
      height="100%"
      style={{
        fontSize: `${fontSize}px`,
        height: '100%',
      }}
      basicSetup={{
        lineNumbers: showLineNumbers,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        searchKeymap: false,
      }}
    />
  );
}
