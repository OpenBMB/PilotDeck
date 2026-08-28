import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  Eye,
  MessageSquarePlus,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import {
  ADD_WORKSPACE_FILE_MENTION_EVENT,
  getWorkspaceRelativePath,
} from '../../utils/workspaceFileMention';
import type { ChatAttachment, ChatFileArtifact } from '../chat/types/types';
import { cn } from '../../lib/utils.js';
import { FileTypeIcon } from '../file-tree/components/FileTypeIcon';
import { getFileIconData } from '../file-tree/constants/fileIcons';

type CardFile = {
  id: string;
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  operation?: 'created' | 'updated';
  status?: 'complete' | 'incomplete';
  sha256?: string;
};

type MessageFileCardProps = {
  file: CardFile;
  project: Project | null;
  source: 'user' | 'agent';
  onBrowse?: (filePath: string) => void;
  compact?: boolean;
};

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() || '';

function fileVisual(file: CardFile) {
  return getFileIconData(file.name, file.mimeType);
}

function formatBytes(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function resolveRelativePath(filePath: string, project: Project | null): string | null {
  const root = project?.fullPath || project?.path || '';
  if (!root) return filePath.replace(/^\.\//, '') || null;
  return getWorkspaceRelativePath(filePath, root);
}

function fullDisplayPath(filePath: string, project: Project | null): string {
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath;
  const root = project?.fullPath || project?.path || '';
  return root ? `${root.replace(/[\\/]$/, '')}/${filePath.replace(/^\.\//, '')}` : filePath;
}

export function MessageFileCard({
  file,
  project,
  source,
  onBrowse,
  compact = false,
}: MessageFileCardProps) {
  const { t } = useTranslation('chat');
  const relativePath = resolveRelativePath(file.path, project);
  const canUseWorkspaceActions = Boolean(project?.name && relativePath);
  const { containerClass: visualClassName } = fileVisual(file);
  const sizeLabel = formatBytes(file.size);
  const typeLabel = extensionOf(file.name).toUpperCase() || 'FILE';
  const handleReference = () => {
    if (!project?.name || !relativePath) return;
    window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
      detail: { projectName: project.name, relativePath },
    }));
  };
  const handleBrowse = async () => {
    if (!onBrowse) return;
    if (source === 'agent' && project?.name && relativePath && file.sha256) {
      try {
        const response = await api.fileContentSha256(project.name, relativePath);
        const currentSha256 = response.headers.get('X-PilotDeck-Content-SHA256');
        if (
          response.ok
          && currentSha256
          && currentSha256 !== file.sha256
          && !window.confirm(t('fileArtifacts.updatedSinceMessage', {
            defaultValue: 'This file has changed since this message. Open the current version?',
          }) as string)
        ) {
          return;
        }
      } catch {
        // The preview itself provides the actionable error if the file is no longer available.
      }
    }
    onBrowse(relativePath || file.path);
  };
  const handleDownload = () => {
    if (!project?.name || !relativePath) return;
    const anchor = document.createElement('a');
    anchor.href = api.fileDownloadUrl(project.name, relativePath);
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const metaLabel = [typeLabel, sizeLabel].filter(Boolean).join(' · ');

  const actionButtons = (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      {onBrowse ? (
        <button
          type="button"
          onClick={() => { void handleBrowse(); }}
          className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          title={t('fileArtifacts.browseTitle', { defaultValue: 'Browse' }) as string}
          aria-label={t('fileArtifacts.browse', { defaultValue: 'Browse {{name}}', name: file.name }) as string}
        >
          <Eye className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      ) : null}
      {source === 'agent' && canUseWorkspaceActions ? (
        <button
          type="button"
          onClick={handleDownload}
          className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          title={t('fileArtifacts.download', { defaultValue: 'Download / save a copy' }) as string}
          aria-label={t('fileArtifacts.downloadName', { defaultValue: 'Download {{name}}', name: file.name }) as string}
        >
          <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      ) : null}
      {canUseWorkspaceActions ? (
        <button
          type="button"
          onClick={handleReference}
          className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          title={t('fileArtifacts.reference', { defaultValue: 'Reference in chat' }) as string}
          aria-label={t('fileArtifacts.referenceName', { defaultValue: 'Reference {{name}} in chat', name: file.name }) as string}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        'group/file-card flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-neutral-200 bg-white shadow-sm transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700',
        compact ? 'px-2.5 py-2' : 'px-3 py-2.5',
      )}
      title={fullDisplayPath(file.path, project)}
      data-file-artifact={source === 'agent' ? file.path : undefined}
    >
      <div className={cn('flex min-w-0 flex-1 items-center', compact ? 'gap-2 basis-[7.5rem]' : 'gap-3 basis-[10rem]')}>
        <button
          type="button"
          onClick={() => { void handleBrowse(); }}
          disabled={!onBrowse}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg',
            compact ? 'h-8 w-8' : 'h-10 w-10',
            visualClassName,
            onBrowse && 'cursor-pointer transition-transform hover:scale-[1.03]',
          )}
          aria-label={t('fileArtifacts.browse', { defaultValue: 'Browse {{name}}', name: file.name }) as string}
        >
          <FileTypeIcon
            filename={file.name}
            mimeType={file.mimeType}
            className={compact ? 'h-4 w-4' : 'h-5 w-5'}
            assetClassName={compact ? 'h-6 w-6' : 'h-8 w-8'}
            strokeWidth={1.8}
          />
        </button>
        <div className="min-w-0 flex-1 text-left">
          <button
            type="button"
            onClick={() => { void handleBrowse(); }}
            disabled={!onBrowse}
            className="block w-full truncate text-left text-[13px] font-medium text-neutral-900 hover:underline disabled:no-underline dark:text-neutral-100"
          >
            {file.name}
          </button>
          {metaLabel || file.status === 'incomplete' ? (
            <div className="mt-0.5 truncate whitespace-nowrap text-[11px] text-neutral-500 dark:text-neutral-400">
              {metaLabel}
              {file.status === 'incomplete' ? (
                <span className="text-amber-700 dark:text-amber-300">
                  {metaLabel ? ' · ' : ''}
                  {t('fileArtifacts.incomplete', { defaultValue: 'Task incomplete' })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {actionButtons}
    </div>
  );
}

export function AgentFileArtifactGroup({
  artifacts,
  project,
  onBrowse,
}: {
  artifacts: ChatFileArtifact[];
  project: Project | null;
  onBrowse?: (filePath: string) => void;
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => {
    const unique = new Map<string, ChatFileArtifact>();
    for (const artifact of artifacts) unique.set(artifact.path, artifact);
    const values = [...unique.values()];
    return {
      values,
      visible: expanded ? values : values.slice(0, 3),
    };
  }, [artifacts, expanded]);

  if (groups.values.length === 0) return null;
  const created = groups.visible.filter((artifact) => artifact.operation === 'created');
  const updated = groups.visible.filter((artifact) => artifact.operation === 'updated');
  const renderSection = (label: string, values: ChatFileArtifact[]) => values.length > 0 ? (
    <section className="space-y-2">
      <div className="text-[12px] font-medium text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="grid grid-cols-1 gap-2">
        {values.map((artifact) => (
          <MessageFileCard
            key={artifact.path}
            file={artifact}
            project={project}
            source="agent"
            onBrowse={onBrowse}
          />
        ))}
      </div>
    </section>
  ) : null;

  return (
    <div className="mt-3 max-w-xl space-y-3">
      {renderSection(t('fileArtifacts.generated', { defaultValue: 'Generated this turn' }) as string, created)}
      {renderSection(t('fileArtifacts.updated', { defaultValue: 'Updated this turn' }) as string, updated)}
      {groups.values.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-[12px] font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
        >
          {expanded
            ? t('fileArtifacts.collapse', { defaultValue: 'Collapse' })
            : t('fileArtifacts.showAll', { defaultValue: 'View all {{count}} files', count: groups.values.length })}
        </button>
      ) : null}
    </div>
  );
}

export function UserAttachmentCards({
  attachments,
  project,
  onBrowse,
}: {
  attachments: ChatAttachment[];
  project: Project | null;
  onBrowse?: (filePath: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2">
      {attachments.map((attachment, index) => (
        <MessageFileCard
          key={`${attachment.path || attachment.name}-${index}`}
          file={{
            id: `${attachment.path || attachment.name}-${index}`,
            name: attachment.name,
            path: attachment.path || attachment.filePath || attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
          }}
          project={project}
          source="user"
          onBrowse={onBrowse}
          compact
        />
      ))}
    </div>
  );
}
