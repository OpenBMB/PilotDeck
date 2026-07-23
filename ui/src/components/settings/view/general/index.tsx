import { useSettingsController } from "../../shared/hooks/useSettingsController";
import ChatInputSection from "./ChatInputSection";
import CodeEditorSection from "./CodeEditorSection";
import GeneralSettingsSection from "./GeneralSettingsSection";

type GeneralSectionsProps = {
  title: string;
};

export default function GeneralSections({ title }: GeneralSectionsProps) {
  const {
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
  } = useSettingsController({ isOpen: true, initialTab: "appearance" });

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
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
