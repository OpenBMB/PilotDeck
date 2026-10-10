export type ComputerUseStatus = {
  enabled: boolean;
  phase: 'disabled' | 'starting' | 'needs-permissions' | 'ready' | 'partial' | 'error';
  platform: string;
  version: string;
  available: boolean;
  permissionOwner?: string;
  permissionAppPath?: string;
  desktopSession?: 'x11' | 'wayland' | 'unknown';
  permissions?: { accessibility: boolean; screenRecording: boolean };
  error?: string;
};
export type ComputerUsePermission = 'accessibility' | 'screenRecording';
export type ComputerUseBridge = {
  status: () => Promise<ComputerUseStatus>;
  setEnabled: (enabled: boolean) => Promise<ComputerUseStatus>;
  refresh: () => Promise<ComputerUseStatus>;
  requestPermission: (permission: ComputerUsePermission) => Promise<ComputerUseStatus>;
  revealPermissionApp: () => Promise<ComputerUseStatus>;
};
