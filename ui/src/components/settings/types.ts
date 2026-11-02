export type SettingsMenuKey =
  | 'general'
  | 'appearance'
  | 'modelPool'
  | 'usage'
  | 'agent'
  | 'agentRoute'
  | 'agentMemory'
  | 'agentResident'
  | 'agentSearch'
  | 'imageGeneration'
  | 'agentSchedule'
  | 'integrations'
  | 'extensions'
  | 'mcpServers'
  | 'officePreview'
  | 'computerUse'
  | 'privacy'
  | 'advanced'
  | 'about';

export type SettingsMenuItem = {
  key: SettingsMenuKey;
  label: string;
  children?: SettingsMenuItem[];
  showDot?: boolean;
};
