import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import { TaskMasterProvider } from './contexts/TaskMasterContext';
import { TasksSettingsProvider } from './contexts/TasksSettingsContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { PluginsProvider } from './contexts/PluginsContext';
import AppShellV2 from './components/app-shell/AppShellV2';
import i18n from './i18n/config.js';

export default function App() {
  // Single wildcard so URL changes don't remount the shell. Params are
  // resolved inside AppShellV2 via useMatch so navigation between
  // /, /p/:name, /p/:name/c/:id, and /session/:id preserves all state.
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AuthProvider>
          <WebSocketProvider>
            <PluginsProvider>
              <TasksSettingsProvider>
                <TaskMasterProvider>
                  <ProtectedRoute>
                    <Router basename={window.__ROUTER_BASENAME__ || ''}>
                      <Routes>
                        <Route path="*" element={<AppShellV2 />} />
                      </Routes>
                    </Router>
                  </ProtectedRoute>
                </TaskMasterProvider>
              </TasksSettingsProvider>
            </PluginsProvider>
          </WebSocketProvider>
        </AuthProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
