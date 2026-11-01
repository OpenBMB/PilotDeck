import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { zincDarkTheme, zincLightTheme } from '../code-editor/utils/zincThemes';
import { splitSkillDocument, updateSkillDocument } from './skillDocument';

export default function SkillForm({
  content,
  onChange,
  disabled,
  isDarkMode,
}: {
  content: string;
  onChange: (content: string) => void;
  disabled: boolean;
  isDarkMode: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const document = splitSkillDocument(content);
  return (
    <div className="skills-form-editor">
      <div className="skills-form-fields">
        <label htmlFor={`${id}-name`}>{t('skillsTab.fieldName')}</label>
        <input
          id={`${id}-name`}
          value={String(document.metadata.name ?? '')}
          disabled={disabled}
          onChange={(event) => onChange(updateSkillDocument(content, { name: event.target.value }))}
        />
        <label htmlFor={`${id}-description`}>{t('skillsTab.fieldDescription')}</label>
        <textarea
          id={`${id}-description`}
          rows={2}
          value={String(document.metadata.description ?? '')}
          disabled={disabled}
          onChange={(event) =>
            onChange(updateSkillDocument(content, { description: event.target.value }))
          }
        />
        <span id={`${id}-body`}>{t('skillsTab.markdownBody')}</span>
      </div>
      <div className="skills-form-body" aria-labelledby={`${id}-body`}>
        <CodeMirror
          value={document.body}
          onChange={(body) => onChange(updateSkillDocument(content, { body }))}
          editable={!disabled}
          extensions={[markdown(), EditorView.lineWrapping]}
          theme={isDarkMode ? zincDarkTheme : zincLightTheme}
          height="100%"
          style={{ height: '100%' }}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            autocompletion: false,
          }}
        />
      </div>
    </div>
  );
}
