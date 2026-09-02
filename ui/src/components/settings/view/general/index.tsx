import { useSettingsController } from "../../shared/hooks/useSettingsController";
import ChatInputSection from "./ChatInputSection";
import CodeEditorSection from "./CodeEditorSection";
import GeneralSettingsSection from "./GeneralSettingsSection";

type GeneralSectionsProps = {
  title: string;
};

export default function GeneralSections({ title: _title }: GeneralSectionsProps) {
  const {
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
  } = useSettingsController({ isOpen: true, initialTab: "appearance" });

  return (
    <div className="general-page-content">
      <GeneralSettingsSection
        projectSortOrder={projectSortOrder}
        onProjectSortOrderChange={setProjectSortOrder}
      />
      <ChatInputSection />
      <CodeEditorSection
        codeEditorSettings={codeEditorSettings}
        onWordWrapChange={(value) => updateCodeEditorSetting("wordWrap", value)}
        onShowMinimapChange={(value) =>
          updateCodeEditorSetting("showMinimap", value)
        }
        onLineNumbersChange={(value) =>
          updateCodeEditorSetting("lineNumbers", value)
        }
        onFontSizeChange={(value) => updateCodeEditorSetting("fontSize", value)}
      />
    </div>
  );
}
