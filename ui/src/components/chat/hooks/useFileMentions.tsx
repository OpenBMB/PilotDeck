import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { api } from '../../../utils/api';
import { isImeEnterEvent } from '../../../utils/ime';
import { escapeRegExp } from '../utils/chatFormatting';
import type { Project } from '../../../types/app';

interface ProjectFileNode {
  name: string;
  type: 'file' | 'directory';
  path?: string;
  children?: ProjectFileNode[];
}

export interface MentionableFile {
  name: string;
  path: string;
  relativePath?: string;
}

interface UseFileMentionsOptions {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputValueRef?: { current: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isValidFileName = (name: unknown): name is string =>
  typeof name === 'string' && name.trim().length > 0 && !name.includes('/');

const flattenFileTree = (files: unknown, basePath = ''): MentionableFile[] => {
  if (!Array.isArray(files)) {
    return [];
  }

  let flattened: MentionableFile[] = [];

  files.forEach((file) => {
    if (!isRecord(file) || !isValidFileName(file.name)) {
      return;
    }

    const fileName = file.name.trim();
    const fullPath = basePath ? `${basePath}/${fileName}` : fileName;
    if (file.type === 'directory' && Array.isArray(file.children)) {
      flattened = flattened.concat(flattenFileTree(file.children, fullPath));
      return;
    }

    if (file.type === 'file') {
      flattened.push({
        name: fileName,
        path: fullPath,
        relativePath: typeof file.path === 'string' ? file.path : undefined,
      });
    }
  });

  return flattened;
};

const getNextKeyboardFileIndex = (
  previousIndex: number,
  fileCount: number,
  direction: 'next' | 'previous',
) => {
  if (fileCount <= 0) {
    return -1;
  }

  if (previousIndex < 0 || previousIndex >= fileCount) {
    return direction === 'previous' ? fileCount - 1 : 0;
  }

  if (direction === 'previous') {
    return previousIndex > 0 ? previousIndex - 1 : fileCount - 1;
  }

  return previousIndex < fileCount - 1 ? previousIndex + 1 : 0;
};

const getKeyboardSelectedFile = (
  files: MentionableFile[],
  selectedIndex: number,
) => files[selectedIndex] || files[0];

export function buildFileMentionInsertion(
  input: string,
  atSymbolPosition: number,
  filePath: string,
): { value: string; caret: number } {
  if (atSymbolPosition < 0 || atSymbolPosition >= input.length || input[atSymbolPosition] !== '@') {
    const separator = input.length > 0 && !/\s$/.test(input) ? ' ' : '';
    const value = `${input}${separator}${filePath} `;
    return { value, caret: value.length };
  }

  const before = input.slice(0, atSymbolPosition);
  const afterAt = input.slice(atSymbolPosition);
  const whitespaceIndex = afterAt.search(/\s/);
  const rawTail = whitespaceIndex !== -1 ? afterAt.slice(whitespaceIndex) : '';
  const tail = rawTail.replace(/^[ \t]+/, '');
  const separator = tail && /^\r?\n/.test(tail) ? '' : ' ';
  const head = `${before}${filePath}${separator}`;
  return {
    value: `${head}${tail}`,
    caret: head.length,
  };
}

export function useFileMentions({
  selectedProject,
  input,
  setInput,
  textareaRef,
  inputValueRef: externalInputValueRef,
}: UseFileMentionsOptions) {
  const [fileList, setFileList] = useState<MentionableFile[]>([]);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);

  // Track the latest in-flight fetch so a refresh triggered by reopening
  // the @ dropdown can supersede the one kicked off on project switch.
  const inFlightFetchRef = useRef<AbortController | null>(null);
  const dismissedQueryRef = useRef<{ input: string; cursorPosition: number } | null>(null);

  const fetchProjectFiles = useCallback(async () => {
    const projectName = selectedProject?.name;
    if (!projectName) {
      setFileList([]);
      setFilteredFiles([]);
      return;
    }

    inFlightFetchRef.current?.abort();
    const abortController = new AbortController();
    inFlightFetchRef.current = abortController;

    try {
      const response = await api.getFiles(projectName, { signal: abortController.signal });
      if (!response.ok) {
        return;
      }
      const files = await response.json();
      if (abortController.signal.aborted) {
        return;
      }
      setFileList(flattenFileTree(files));
    } catch (error) {
      // Ignore aborts from rapid project switches / refreshes.
      if ((error as { name?: string })?.name === 'AbortError') {
        return;
      }
      console.error('Error fetching files:', error);
    } finally {
      if (inFlightFetchRef.current === abortController) {
        inFlightFetchRef.current = null;
      }
    }
  }, [selectedProject?.name]);

  // Initial fetch + reset on project change.
  useEffect(() => {
    setFileList([]);
    setFileMentions([]);
    setFilteredFiles([]);
    setShowFileDropdown(false);
    setSelectedFileIndex(-1);
    setAtSymbolPosition(-1);
    dismissedQueryRef.current = null;
    fetchProjectFiles();
    return () => {
      inFlightFetchRef.current?.abort();
    };
  }, [fetchProjectFiles]);

  // Refresh whenever the @ dropdown transitions from closed → open, so
  // files created / renamed / deleted in the Files tab since the last
  // project switch show up immediately. We intentionally do NOT refetch
  // on every keystroke while the dropdown is already open — the snapshot
  // taken on open is good enough for that session of typing.
  const wasDropdownOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasDropdownOpenRef.current;
    wasDropdownOpenRef.current = showFileDropdown;
    if (!wasOpen && showFileDropdown) {
      fetchProjectFiles();
    }
  }, [showFileDropdown, fetchProjectFiles]);

  useEffect(() => {
    if (!selectedProject) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setSelectedFileIndex(-1);
      setFilteredFiles([]);
      dismissedQueryRef.current = null;
      return;
    }

    const textBeforeCursor = input.slice(0, cursorPosition);
    const mentionMatch = textBeforeCursor.match(/(^|\s)@(\S*)$/);

    if (!mentionMatch) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      dismissedQueryRef.current = null;
      return;
    }

    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    const textAfterAt = mentionMatch[2] || '';

    if (
      dismissedQueryRef.current?.input === input
      && dismissedQueryRef.current.cursorPosition === cursorPosition
    ) {
      setShowFileDropdown(false);
      setAtSymbolPosition(lastAtIndex);
      setSelectedFileIndex(-1);
      setFilteredFiles([]);
      return;
    }

    const matchingFiles = fileList
      .filter(
        (file) =>
          file.name.toLowerCase().includes(textAfterAt.toLowerCase()) ||
          file.path.toLowerCase().includes(textAfterAt.toLowerCase()),
      )
      .slice(0, 10);

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(matchingFiles.length > 0 ? 0 : -1);
    setFilteredFiles(matchingFiles);
  }, [input, cursorPosition, fileList, selectedProject]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const { value: newInput, caret: newCursorPosition } = buildFileMentionInsertion(
        input,
        atSymbolPosition,
        file.path,
      );

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      if (externalInputValueRef) {
        externalInputValueRef.current = newInput;
      }
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      dismissedQueryRef.current = null;

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [externalInputValueRef, input, atSymbolPosition, textareaRef, setInput],
  );

  const highlightFileSuggestion = useCallback(
    (index: number) => {
      setSelectedFileIndex((previousIndex) => {
        if (index < 0 || index >= filteredFiles.length) {
          return previousIndex;
        }
        return index;
      });
    },
    [filteredFiles.length],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown) {
        return false;
      }

      if (filteredFiles.length === 0) {
        if (event.key === 'Escape') {
          event.preventDefault();
          dismissedQueryRef.current = { input, cursorPosition };
          setShowFileDropdown(false);
          return true;
        }
        if (event.key === 'Tab' || event.key === 'Enter') {
          if (isImeEnterEvent(event)) {
            return false;
          }
          event.preventDefault();
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          getNextKeyboardFileIndex(previousIndex, filteredFiles.length, 'next'),
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          getNextKeyboardFileIndex(previousIndex, filteredFiles.length, 'previous'),
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        if (isImeEnterEvent(event)) {
          return false;
        }
        event.preventDefault();
        const selectedFile = getKeyboardSelectedFile(filteredFiles, selectedFileIndex);
        if (selectedFile) {
          selectFile(selectedFile);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        dismissedQueryRef.current = { input, cursorPosition };
        setShowFileDropdown(false);
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile, input, cursorPosition],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    highlightFileSuggestion,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
