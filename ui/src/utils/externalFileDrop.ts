import { useEffect } from 'react';
import { getWorkspaceRelativePath } from './workspaceFileMention';

type DataTransferLike = {
  types?: ArrayLike<string> | null;
  dropEffect?: string;
} | null | undefined;

type DragEventLike = {
  preventDefault: () => void;
  stopPropagation?: () => void;
  dataTransfer?: DataTransferLike;
  target?: EventTarget | null;
};

export function isExternalFileDrag(event: { dataTransfer?: DataTransferLike }): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

export function allowExternalFileDrop(event: DragEventLike): void {
  event.preventDefault();
  event.stopPropagation?.();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
}

export function readExternalFileDropTarget(event: { target?: EventTarget | null }): {
  dropPath: string | null;
  dropType: 'file' | 'directory' | null;
} {
  const element = event.target instanceof Element
    ? event.target.closest('[data-file-drop-path]')
    : null;
  if (!element) {
    return { dropPath: null, dropType: null };
  }

  const dropPath = element.getAttribute('data-file-drop-path');
  const dropType = element.getAttribute('data-file-drop-type');
  return {
    dropPath,
    dropType: dropType === 'directory' || dropType === 'file' ? dropType : null,
  };
}

export function resolveExternalFileDropTargetPath(
  dropPath: string | null,
  dropType: 'file' | 'directory' | null,
  workspaceRoot: string,
): string {
  if (!dropPath) return '';

  const relativePath = getWorkspaceRelativePath(dropPath, workspaceRoot);
  if (!relativePath) return '';
  if (dropType === 'directory') return relativePath;

  const slashIndex = relativePath.lastIndexOf('/');
  return slashIndex === -1 ? '' : relativePath.slice(0, slashIndex);
}

/**
 * Keep OS file drags from turning the whole page into a copy target, while
 * still preventing the browser from navigating away on an accidental drop.
 * Allowed surfaces must preventDefault and set dropEffect to "copy" first.
 */
export function useRejectExternalFileDropOutsideTargets(): void {
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!isExternalFileDrag(event)) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none';
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
    };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, []);
}
