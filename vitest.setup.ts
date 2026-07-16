import { vi } from 'vitest';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (typeof options?.defaultValue === 'string') {
        return options.defaultValue;
      }
      if (key === 'messageTypes.error') return 'Error';
      if (key === 'messageTypes.pilotdeck') return 'PilotDeck';
      if (key === 'permissions.grant') return `Grant ${String(options?.tool || 'tool')} for this chat`;
      if (key === 'permissions.openSettings') return 'Open settings';
      if (key === 'permissions.addTo') return `Temporarily allows ${String(options?.entry || '')} in this chat only.`;
      if (key === 'permissions.added') return 'Granted for this chat';
      if (key === 'permissions.retry') return 'Retry in this chat to use the tool.';
      if (key === 'permissions.error') return 'Unable to grant this chat permission. Please try again.';
      return key;
    },
  }),
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

const MockIcon = ({ children: _children, ...props }: React.SVGProps<SVGSVGElement>) =>
  React.createElement('svg', props);

vi.mock('lucide-react', () => ({
  Activity: MockIcon,
  AlertCircle: MockIcon,
  AlertTriangle: MockIcon,
  ArrowUp: MockIcon,
  AtSign: MockIcon,
  Atom: MockIcon,
  BarChart3: MockIcon,
  Bot: MockIcon,
  Box: MockIcon,
  Brain: MockIcon,
  Check: MockIcon,
  CheckCircle2: MockIcon,
  ChevronLeft: MockIcon,
  ChevronDown: MockIcon,
  ChevronRight: MockIcon,
  Circle: MockIcon,
  CircleGauge: MockIcon,
  ClipboardList: MockIcon,
  Clock: MockIcon,
  Command: MockIcon,
  Copy: MockIcon,
  Database: MockIcon,
  FileText: MockIcon,
  Folder: MockIcon,
  FolderOpen: MockIcon,
  FolderGit2: MockIcon,
  Hand: MockIcon,
  HelpCircle: MockIcon,
  LayoutGrid: MockIcon,
  ListChecks: MockIcon,
  Loader2: MockIcon,
  MessageSquare: MockIcon,
  MessageSquareText: MockIcon,
  MoreHorizontal: MockIcon,
  Paperclip: MockIcon,
  PanelLeftOpen: MockIcon,
  PanelRightClose: MockIcon,
  PanelRightOpen: MockIcon,
  Pencil: MockIcon,
  Pin: MockIcon,
  Search: MockIcon,
  ShieldAlert: MockIcon,
  Sparkles: MockIcon,
  Square: MockIcon,
  Terminal: MockIcon,
  User: MockIcon,
  Wrench: MockIcon,
  X: MockIcon,
  XCircle: MockIcon,
  Zap: MockIcon,
  Radio: MockIcon,
}));
