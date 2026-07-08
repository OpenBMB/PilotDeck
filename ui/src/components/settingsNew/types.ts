export type SettingsNewMenuKey =
  | 'general'
  | 'modelPool'
  | 'agent'
  | 'agentModel'
  | 'agentRoute'
  | 'agentMemory'
  | 'agentResident'
  | 'agentSearch'
  | 'agentSchedule'
  | 'integrations'
  | 'extensions'
  | 'privacy'
  | 'advanced'
  | 'about';

export type SettingsNewMenuItem = {
  key: SettingsNewMenuKey;
  label: string;
  children?: SettingsNewMenuItem[];
  showDot?: boolean;
};

