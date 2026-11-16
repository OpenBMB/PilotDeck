import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// The reminder window receives no general application, filesystem or update bridge.
contextBridge.exposeInMainWorld('taskReminders', {
  onUpdate(callback: (value: unknown) => void) {
    const listener = (_event: IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on('pilotdeck:task-reminders-update', listener);
    return () => ipcRenderer.off('pilotdeck:task-reminders-update', listener);
  },
  view: (id: string) => ipcRenderer.send('pilotdeck:task-reminder-action', { action: 'view', id }),
  dismiss: (id: string) => ipcRenderer.send('pilotdeck:task-reminder-action', { action: 'dismiss', id }),
});
