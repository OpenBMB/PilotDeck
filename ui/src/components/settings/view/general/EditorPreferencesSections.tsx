import { useCallback, useEffect, useState } from "react";
import CodeEditorSection from "./CodeEditorSection";
import type { CodeEditorSettingsState } from "../../shared/types";
import { DEFAULT_CODE_EDITOR_SETTINGS } from "../../shared/constants";

function readEditorSettings(): CodeEditorSettingsState {
  return {
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    wordWrap: localStorage.getItem("codeEditorWordWrap") === "true",
    showMinimap: localStorage.getItem("codeEditorShowMinimap") !== "false",
    lineNumbers: localStorage.getItem("codeEditorLineNumbers") !== "false",
    fontSize: localStorage.getItem("codeEditorFontSize") ?? DEFAULT_CODE_EDITOR_SETTINGS.fontSize,
  };
}

export default function EditorPreferencesSections() {
  const [settings, setSettings] = useState<CodeEditorSettingsState>(readEditorSettings);
  useEffect(() => {
    localStorage.setItem("codeEditorTheme", settings.theme);
    localStorage.setItem("codeEditorWordWrap", String(settings.wordWrap));
    localStorage.setItem("codeEditorShowMinimap", String(settings.showMinimap));
    localStorage.setItem("codeEditorLineNumbers", String(settings.lineNumbers));
    localStorage.setItem("codeEditorFontSize", settings.fontSize);
    window.dispatchEvent(new Event("codeEditorSettingsChanged"));
  }, [settings]);
  const update = useCallback(<K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => setSettings((current) => ({ ...current, [key]: value })), []);
  return <div className="general-page-content"><CodeEditorSection codeEditorSettings={settings} onWordWrapChange={(value) => update("wordWrap", value)} onShowMinimapChange={(value) => update("showMinimap", value)} onLineNumbersChange={(value) => update("lineNumbers", value)} onFontSizeChange={(value) => update("fontSize", value)} /></div>;
}
