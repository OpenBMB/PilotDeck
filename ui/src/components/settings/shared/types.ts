import type { Dispatch, SetStateAction } from "react";
import type { Contribution, SurfaceProps } from "../../../composition/contracts";

export type SettingsMainTab =
  | "appearance"
  | "permissions"
  | "config"
  | "mcp"
  | "gateway";

export type ProjectSortOrder = "name" | "date";
export type SaveStatus = "success" | "error" | null;

export type SettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type CodeEditorSettingsState = {
  theme: "dark" | "light";
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

export type SettingsProps = {
  onClose: () => void;
  projects?: SettingsProject[];
  section?: string;
  moduleSettings?: Contribution[];
  host?: SurfaceProps["host"];
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
