export type CodeEditorDiffInfo = {
  old_string?: string;
  new_string?: string;
  [key: string]: unknown;
};

export type CodeEditorFile = {
  name: string;
  path: string;
  projectName?: string;
  diffInfo?: CodeEditorDiffInfo | null;
  renamedFromPath?: string;
  [key: string]: unknown;
};

export type CodeEditorTab = {
  id: string;
  fileStack: CodeEditorFile[];
  dirty: boolean;
};

export type CodeEditorSettingsState = {
  isDarkMode: boolean;
  wordWrap: boolean;
  minimapEnabled: boolean;
  showLineNumbers: boolean;
  fontSize: string;
};
