import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { useTranslation } from 'react-i18next';
import { isImeEnterEvent } from '../../../utils/ime';
import {
  ADD_WORKSPACE_FILE_MENTION_EVENT,
  isWorkspaceFileMentionRequest,
} from '../../../utils/workspaceFileMention';
import type { Project } from '../../../types/app';

export interface MentionableFile {
  id?: string;
  name: string;
  path: string;
  relativePath?: string;
  kind?: 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
  matches?: Array<{ field: string; start: number; end: number }>;
}

interface UseFileMentionsOptions {
  selectedProject: Project | null;
  enabled?: boolean;
  mentionScopeKey: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

export function useFileMentions({
  selectedProject,
  enabled = true,
  mentionScopeKey,
  input,
  setInput,
  textareaRef,
}: UseFileMentionsOptions) {
  const { t } = useTranslation('chat');
  const [selectedFileMentions, setSelectedFileMentions] = useState<MentionableFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [mentionQuery, setMentionQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const [cursorPosition, setCursorPositionState] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  const hasCursorPositionRef = useRef(false);

  const setCursorPosition = useCallback((position: number) => {
    hasCursorPositionRef.current = true;
    setCursorPositionState(position);
  }, []);

  // Track the latest in-flight fetch so a refresh triggered by reopening
  // the @ dropdown can supersede the one kicked off on project switch.
  const inFlightFetchRef = useRef<AbortController | null>(null);

  const fetchProjectFiles = useCallback(async ({
    query,
    cursor,
    append = false,
  }: {
    query: string;
    cursor?: string;
    append?: boolean;
  }) => {
    const projectKey = selectedProject?.fullPath || selectedProject?.path || '';
    if (!enabled || !projectKey) {
      setFilteredFiles([]);
      setNextCursor(undefined);
      setFileListError(t('input.projectPathMissing', { defaultValue: 'The current project path is unavailable.' }));
      return;
    }

    inFlightFetchRef.current?.abort();
    const abortController = new AbortController();
    inFlightFetchRef.current = abortController;

    try {
      setIsLoadingFiles(true);
      setFileListError(null);
      const params = new URLSearchParams({
        projectKey,
        limit: '100',
        includeDirs: 'true',
      });
      if (query.trim()) params.set('query', query.trim());
      if (cursor) params.set('cursor', cursor);
      const response = await authenticatedFetch(`/api/projects/files?${params}`, {
        signal: abortController.signal,
      });
      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType && !contentType.toLowerCase().includes('application/json')) {
        throw new Error(t('input.projectFilesNonJson', {
          contentType,
          defaultValue: `The project files service returned an invalid response (${contentType}). Restart the backend service.`,
        }));
      }
      const page = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = page?.error?.code;
        const message = page?.error?.message || t('input.projectFilesLoadFailedStatus', {
          status: response.status,
          defaultValue: `Failed to load project files (${response.status}).`,
        });
        throw new Error(code ? `${message} [${code}]` : message);
      }
      const items: MentionableFile[] = (Array.isArray(page?.items) ? page.items : [])
        .filter((item: Record<string, unknown>) => (
          item.kind === 'file' || item.kind === 'directory'
        ))
        .map((item: Record<string, unknown>) => ({
          id: typeof item.id === 'string' ? item.id : undefined,
          name: String(item.name || ''),
          path: String(item.relativePath || item.name || ''),
          relativePath: String(item.relativePath || ''),
          kind: item.kind as 'file' | 'directory',
          size: typeof item.size === 'number' ? item.size : undefined,
          mtimeMs: typeof item.mtimeMs === 'number' ? item.mtimeMs : undefined,
          matches: Array.isArray(item.matches)
            ? item.matches as Array<{ field: string; start: number; end: number }>
            : undefined,
        }));
      setFilteredFiles((previous) => append ? [...previous, ...items] : items);
      setNextCursor(typeof page?.nextCursor === 'string' ? page.nextCursor : undefined);
      setSelectedFileIndex(-1);
    } catch (error) {
      // Ignore aborts from rapid project switches / refreshes.
      if ((error as { name?: string })?.name === 'AbortError') {
        return;
      }
      console.error('Error fetching files:', error);
      if (!append) setFilteredFiles([]);
      setFileListError(error instanceof Error
        ? error.message
        : t('input.projectFilesLoadFailed', { defaultValue: 'Failed to load project files.' }));
    } finally {
      if (inFlightFetchRef.current === abortController) {
        inFlightFetchRef.current = null;
      }
      if (!abortController.signal.aborted) setIsLoadingFiles(false);
    }
  }, [enabled, selectedProject?.fullPath, selectedProject?.path, t]);

  // Cursor and mention UI state belong to a single draft. A conversation
  // switch can keep the same project mounted, so project identity alone is
  // not enough to prevent insertion at a previous conversation's cursor.
  useEffect(() => {
    setSelectedFileMentions([]);
    setFilteredFiles([]);
    setShowFileDropdown(false);
    setSelectedFileIndex(-1);
    setMentionQuery('');
    setNextCursor(undefined);
    setFileListError(null);
    setCursorPositionState(0);
    setAtSymbolPosition(-1);
    hasCursorPositionRef.current = false;
    inFlightFetchRef.current?.abort();
  }, [enabled, mentionScopeKey]);

  // Query the gateway-backed project file index whenever the active @ query
  // changes. Keeping this server-side preserves cursor/query signatures and
  // allows the response's match ranges to stay authoritative.
  useEffect(() => {
    if (!enabled || !showFileDropdown) {
      inFlightFetchRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchProjectFiles({ query: mentionQuery });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchProjectFiles, mentionQuery, showFileDropdown]);

  useEffect(() => {
    if (!enabled) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setMentionQuery('');
      return;
    }
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setMentionQuery('');
      return;
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    if (textAfterAt.includes(' ')) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setMentionQuery('');
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setMentionQuery(textAfterAt);
  }, [enabled, input, cursorPosition]);

  const focusMention = useCallback(
    (position: number) => {
      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.setSelectionRange(position, position);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [textareaRef],
  );

  const addExternalFileMention = useCallback(
    (relativePath: string) => {
      const insertionPosition = hasCursorPositionRef.current ? cursorPosition : input.length;
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const name = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath;
      setSelectedFileMentions((previousMentions) =>
        previousMentions.some((mention) => mention.path === normalizedPath)
          ? previousMentions
          : [...previousMentions, {
              name,
              path: normalizedPath,
              relativePath: normalizedPath,
              kind: 'file',
            }],
      );
      setCursorPosition(insertionPosition);
      focusMention(insertionPosition);
    },
    [cursorPosition, focusMention, input.length, setCursorPosition],
  );

  useEffect(() => {
    const handleAddWorkspaceFileMention = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!enabled) return;
      if (!isWorkspaceFileMentionRequest(detail)) return;
      if (detail.projectName !== selectedProject?.name) return;
      addExternalFileMention(detail.relativePath);
    };

    window.addEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, handleAddWorkspaceFileMention);
    return () => {
      window.removeEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, handleAddWorkspaceFileMention);
    };
  }, [addExternalFileMention, enabled, selectedProject?.name]);

  const renderInputWithMentions = useCallback((text: string) => text, []);

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length;

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setSelectedFileMentions((previousMentions) =>
        previousMentions.some((mention) => mention.path === file.path)
          ? previousMentions
          : [...previousMentions, file],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      focusMention(newCursorPosition);
    },
    [input, atSymbolPosition, focusMention, setCursorPosition, setInput],
  );

  const removeFileMention = useCallback((path: string) => {
    setSelectedFileMentions((mentions) => mentions.filter((mention) => mention.path !== path));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [textareaRef]);

  const clearFileMentions = useCallback(() => {
    setSelectedFileMentions([]);
  }, []);

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown || filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        if (isImeEnterEvent(event)) {
          return false;
        }
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileDropdown(false);
        return true;
      }

      return false;
    },
    [
      filteredFiles,
      selectFile,
      selectedFileIndex,
      showFileDropdown,
    ],
  );

  const loadMoreFiles = useCallback(() => {
    if (!nextCursor || isLoadingFiles) return;
    void fetchProjectFiles({
      query: mentionQuery,
      cursor: nextCursor,
      append: true,
    });
  }, [fetchProjectFiles, isLoadingFiles, mentionQuery, nextCursor]);

  return {
    showFileDropdown,
    mentionQuery,
    filteredFiles,
    selectedFileIndex,
    isLoadingFiles,
    fileListError,
    hasMoreFiles: Boolean(nextCursor),
    loadMoreFiles,
    selectedFileMentions,
    removeFileMention,
    clearFileMentions,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
