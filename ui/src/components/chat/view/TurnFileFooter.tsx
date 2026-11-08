import type { Project } from '../../../types/app';
import TurnChangesCard from '../../chat-review/TurnChangesCard';
import { AnimatedDisclosure } from '../../ui/AnimatedDisclosure';
import type { RenderableMessageItem } from '../utils/processGrouping';

/** File results belong to the whole turn, including turns that stop after a tool. */
export function TurnFileFooter({ files, project, onBrowse }: {
  files: NonNullable<RenderableMessageItem['turnFiles']>;
  project: Project | null;
  onBrowse?: (path: string) => void;
}) {
  if (!files.visible) return null;
  return <AnimatedDisclosure expanded data-turn-file-footer contentClassName="[&>section]:mb-4">
    <TurnChangesCard turnId={files.turnId} artifacts={files.artifacts} project={project} onBrowse={onBrowse} />
  </AnimatedDisclosure>;
}
