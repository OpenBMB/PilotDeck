import { useCallback, useEffect, useState } from "react";
import GeneralSettingsSection from "./GeneralSettingsSection";
import type { ProjectSortOrder } from "../../shared/types";

const SETTINGS_KEY = "pilotdeck-settings";

function readProjectSortOrder(): ProjectSortOrder {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}").projectSortOrder === "name" ? "name" : "date";
  } catch {
    return "date";
  }
}

export default function HostPreferencesSections() {
  const [projectSortOrder, setProjectSortOrderState] = useState<ProjectSortOrder>(readProjectSortOrder);
  useEffect(() => { setProjectSortOrderState(readProjectSortOrder()); }, []);
  const setProjectSortOrder = useCallback((value: ProjectSortOrder) => {
    setProjectSortOrderState(value);
    try {
      const existing = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Record<string, unknown>;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...existing, projectSortOrder: value, lastUpdated: new Date().toISOString() }));
      window.dispatchEvent(new Event("pilotdeck-settings-changed"));
    } catch (error) {
      console.error("Failed to persist host preferences:", error);
    }
  }, []);
  return <div className="general-page-content"><GeneralSettingsSection projectSortOrder={projectSortOrder} onProjectSortOrderChange={setProjectSortOrder} /></div>;
}
