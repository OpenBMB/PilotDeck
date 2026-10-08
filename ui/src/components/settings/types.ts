export type SettingsMenuKey =
  | 'general'
  | 'appearance'
  | 'modelPool'
  | 'agent'
  | 'agentRoute'
  | 'agentMemory'
  | 'agentResident'
  | 'agentSearch'
  | 'agentSchedule'
  | 'integrations'
  | 'extensions'
  | 'mcpServers'
  | 'officePreview'
  | 'privacy'
  | 'advanced'
  | 'about';

export type SettingsMenuItem = {
  key: SettingsMenuKey;
  label: string;
  children?: SettingsMenuItem[];
  showDot?: boolean;
};
