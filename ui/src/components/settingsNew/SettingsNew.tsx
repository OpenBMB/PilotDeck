import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../shared/view/ui/Button";
import type { SettingsProps } from "../settings/types/types";
import type { SettingsNewMenuKey } from "./types";
import SettingsNewSidebar from "./view/SettingsNewSidebar";
import SettingsNewContent from "./view/SettingsNewContent";

const mapInitialTabToMenuKey = (
  tab: string | undefined,
): SettingsNewMenuKey => {
  const [base] = String(tab || "").split(":", 1);
  switch (base) {
    case "permissions":
      return "privacy";
    case "mcp":
      return "integrations";
    case "gateway":
      return "advanced";
    case "config":
      return "modelPool";
    default:
      return "general";
  }
};

export default function SettingsNew({
  isOpen,
  onClose,
  initialTab,
}: SettingsProps) {
  const initialKey = useMemo(
    () => mapInitialTabToMenuKey(initialTab),
    [initialTab],
  );
  const [selectedKey, setSelectedKey] =
    useState<SettingsNewMenuKey>(initialKey);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedKey(mapInitialTabToMenuKey(initialTab));
  }, [isOpen, initialTab]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4">
      <div className="relative flex h-full w-full overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-7xl md:rounded-xl">
        <div className="flex h-full w-full flex-col md:flex-row">
          <SettingsNewSidebar
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            onClose={onClose}
          />
          <SettingsNewContent selectedKey={selectedKey} />
        </div>
      </div>
    </div>
  );
}
