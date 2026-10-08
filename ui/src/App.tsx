import './components/desktop/desktop.css';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import { TaskMasterProvider } from './contexts/TaskMasterContext';
import { TasksSettingsProvider } from './contexts/TasksSettingsContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { PluginsProvider } from './contexts/PluginsContext';
import { ToastProvider } from './contexts/ToastContext';
import AppShellV2 from './components/app-shell/AppShellV2';
import { ConfirmProvider } from './components/ui/ConfirmDialog';
import i18n from './i18n/config.js';

function DesktopAppearanceSync() {
  const { i18n } = useTranslation();
  const { themeMode } = useTheme();
  useEffect(() => {
    const language = i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en';
    // The preload-owned caption observes this attribute; use the same resolved
    // i18n language as the UI and the native application menu.
    document.documentElement.lang = language;
    void window.pilotdeckDesktop?.setAppearance?.({
      language,
      themeMode,
    }).catch(error => console.warn('Could not sync desktop appearance', error));
  }, [i18n.resolvedLanguage, themeMode]);
  return null;
}

export default function App() {
  // Single wildcard so URL changes don't remount the shell. Params are
  // resolved inside AppShellV2 via useMatch so navigation between
  // /, /p/:name, /p/:name/c/:id, /session/:id, /cron, and /skills preserves all state.
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <DesktopAppearanceSync />
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <WebSocketProvider>
                <PluginsProvider>
                  <TasksSettingsProvider>
                    <TaskMasterProvider>
                      <Router basename={window.__ROUTER_BASENAME__ || ''}>
                        <ProtectedRoute>
                          <Routes>
                            <Route path="*" element={<AppShellV2 />} />
                          </Routes>
                        </ProtectedRoute>
                      </Router>
                    </TaskMasterProvider>
                  </TasksSettingsProvider>
                </PluginsProvider>
              </WebSocketProvider>
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
