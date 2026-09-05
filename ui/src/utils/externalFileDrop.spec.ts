import { describe, expect, it } from 'vitest';
import {
  isExternalFileDrag,
  readExternalFileDropTarget,
  resolveExternalFileDropTargetPath,
} from './externalFileDrop';

describe('isExternalFileDrag', () => {
  it('detects OS file drags from dataTransfer types', () => {
    expect(isExternalFileDrag({ dataTransfer: { types: ['Files'] } })).toBe(true);
    expect(isExternalFileDrag({ dataTransfer: { types: ['text/plain'] } })).toBe(false);
    expect(isExternalFileDrag({ dataTransfer: null })).toBe(false);
  });
});

describe('resolveExternalFileDropTargetPath', () => {
  const workspaceRoot = 'C:\\Work\\PilotDeck';

  it('uploads to the workspace root when no row is targeted', () => {
    expect(resolveExternalFileDropTargetPath(null, null, workspaceRoot)).toBe('');
  });

  it('uploads into the hovered directory', () => {
    expect(resolveExternalFileDropTargetPath(
      `${workspaceRoot}\\docs`,
      'directory',
      workspaceRoot,
    )).toBe('docs');
  });

  it('uploads next to a hovered file', () => {
    expect(resolveExternalFileDropTargetPath(
      `${workspaceRoot}\\docs\\report.txt`,
      'file',
      workspaceRoot,
    )).toBe('docs');
  });

  it('uploads to the workspace root when a top-level file is hovered', () => {
    expect(resolveExternalFileDropTargetPath(
      `${workspaceRoot}\\readme.md`,
      'file',
      workspaceRoot,
    )).toBe('');
  });
});

describe('readExternalFileDropTarget', () => {
  it('reads path metadata from the closest drop row', () => {
    const row = document.createElement('div');
    row.setAttribute('data-file-drop-path', '/workspace/docs');
    row.setAttribute('data-file-drop-type', 'directory');
    const child = document.createElement('span');
    row.appendChild(child);

    expect(readExternalFileDropTarget({ target: child })).toEqual({
      dropPath: '/workspace/docs',
      dropType: 'directory',
    });
    expect(readExternalFileDropTarget({ target: document.createElement('div') })).toEqual({
      dropPath: null,
      dropType: null,
    });
  });
});
