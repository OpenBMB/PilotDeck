import { useTranslation } from 'react-i18next';
import { Terminal } from 'lucide-react';
import type { Project, ProjectSession } from '../../types/app';
import Shell from '../shell/view/Shell';

type ShellV2Props = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isActive: boolean;
};

export default function ShellV2({ selectedProject, selectedSession, isActive }: ShellV2Props) {
  const { t } = useTranslation();
  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-[13px] text-neutral-500">
        {t('alwaysOn:shell.noProject')}
      </div>
    );
  }

  const cwd = selectedProject.fullPath || selectedProject.path || selectedProject.name;

  return (
    <div className="flex h-full w-full flex-col" style={{ background: '#0a0a0a', color: '#e5e5e5' }}>
      <div
        className="text-xxs flex h-10 shrink-0 items-center gap-2 border-b px-5"
        style={{ borderColor: '#27272a', color: '#a1a1aa' }}
      >
        <Terminal className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span className="font-mono">zsh · {cwd}</span>
      </div>
      <div className="min-h-0 w-full flex-1">
        <Shell
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isActive={isActive}
          autoConnect
        />
      </div>
    </div>
  );
}
