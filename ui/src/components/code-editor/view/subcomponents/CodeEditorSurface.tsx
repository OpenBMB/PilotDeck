import CodeMirror from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';
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
}: CodeEditorSurfaceProps) {
  if (htmlPreview && isHtmlFile && htmlPreviewUrl) {
    return <HtmlDocumentPreview url={htmlPreviewUrl} title={`Preview: ${fileName}`} />;
  }

  if (markdownPreview && isMarkdownFile) {
    return (
      <div className="h-full overflow-y-auto bg-white dark:bg-neutral-950">
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
      extensions={extensions}
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
        searchKeymap: true,
      }}
    />
  );
}
