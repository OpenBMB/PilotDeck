import type { Project } from '../../types/app';
import TurnChangesCard from '../chat-review/TurnChangesCard';
import { AnimatedDisclosure } from '../ui/AnimatedDisclosure';
import type { RenderableMessageItem } from './processGrouping';

/** File results belong to the whole turn, including turns that stop after a tool. */
export function TurnFileFooter({ files, project, onBrowse }: {
  files: NonNullable<RenderableMessageItem['turnFiles']>;
  project: Project | null;
  onBrowse?: (path: string) => void;
}) {
  return <AnimatedDisclosure expanded={files.visible} data-turn-file-footer>
    <TurnChangesCard turnId={files.turnId} artifacts={files.artifacts} project={project} onBrowse={onBrowse} />
  </AnimatedDisclosure>;
}
