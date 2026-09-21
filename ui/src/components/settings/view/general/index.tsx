import ChatInputSection from "./ChatInputSection";
import EditorPreferencesSections from "./EditorPreferencesSections";
import HostPreferencesSections from "./HostPreferencesSections";

type GeneralSectionsProps = {
  title: string;
};

export default function GeneralSections({ title: _title }: GeneralSectionsProps) {
  return (
    <div className="general-page-content">
      <HostPreferencesSections />
      <ChatInputSection />
      <EditorPreferencesSections />
    </div>
  );
}
