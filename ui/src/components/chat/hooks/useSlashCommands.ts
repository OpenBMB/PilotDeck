import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { isImeEnterEvent } from '../../../utils/ime';
import { safeLocalStorage } from '../utils/chatStorage';
import type { Project } from '../../../types/app';

const COMMAND_QUERY_DEBOUNCE_MS = 150;

export interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  matches?: Array<{ field: string; start: number; end: number }>;
  [key: string]: unknown;
}

interface UseSlashCommandsOptions {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputValueRef?: { current: string };
}

const getCommandHistoryKey = (projectName: string) => `command_history_${projectName}`;

const readCommandHistory = (projectName: string): Record<string, number> => {
  const history = safeLocalStorage.getItem(getCommandHistoryKey(projectName));
  if (!history) {
    return {};
  }

  try {
    return JSON.parse(history);
  } catch (error) {
    console.error('Error parsing command history:', error);
    return {};
  }
};

const saveCommandHistory = (projectName: string, history: Record<string, number>) => {
  safeLocalStorage.setItem(getCommandHistoryKey(projectName), JSON.stringify(history));
};

const getCommandKey = (command: SlashCommand) =>
  `${command.name}::${command.namespace || command.type || 'other'}::${command.path || ''}`;

const getCommandNamespace = (command: SlashCommand) =>
  command.namespace || command.type || 'other';

const groupCommandsForDisplay = (
  commands: SlashCommand[],
  frequentCommands: SlashCommand[],
): SlashCommand[] => {
  const preferredOrder = frequentCommands.length > 0
    ? ['pinned', 'frequent', 'builtin', 'project', 'user', 'other']
    : ['pinned', 'builtin', 'project', 'user', 'other'];
  const groups = new Map<string, SlashCommand[]>();
  const frequentCommandKeys = new Set(frequentCommands.map(getCommandKey));

  for (const command of commands) {
    if (frequentCommandKeys.has(getCommandKey(command))) {
      continue;
    }
    const namespace = getCommandNamespace(command);
    const group = groups.get(namespace) || [];
    group.push(command);
    groups.set(namespace, group);
  }

  if (frequentCommands.length > 0) {
    groups.set(
      'frequent',
      frequentCommands.map((command) => ({
        ...command,
        namespace: 'frequent',
      })),
    );
  }

  const extraNamespaces = [...groups.keys()].filter(
    (namespace) => !preferredOrder.includes(namespace),
  );
  return [...preferredOrder, ...extraNamespaces].flatMap(
    (namespace) => groups.get(namespace) || [],
  );
};

export function useSlashCommands({
  selectedProject,
  input,
  setInput,
  textareaRef,
  inputValueRef: externalInputValueRef,
}: UseSlashCommandsOptions) {
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [selectedCommands, setSelectedCommands] = useState<SlashCommand[]>([]);
  const [slashPosition, setSlashPosition] = useState(-1);

  const commandQueryTimerRef = useRef<number | null>(null);

  const clearCommandQueryTimer = useCallback(() => {
    if (commandQueryTimerRef.current !== null) {
      window.clearTimeout(commandQueryTimerRef.current);
      commandQueryTimerRef.current = null;
    }
  }, []);

  const resetCommandMenuState = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery('');
    setSelectedCommandIndex(-1);
    clearCommandQueryTimer();
  }, [clearCommandQueryTimer]);

  const dismissCommandMenu = useCallback(() => {
    if (showCommandMenu && slashPosition >= 0) {
      setInput((prev) => {
        const before = prev.slice(0, slashPosition);
        const after = prev.slice(slashPosition);
        const spaceIdx = after.indexOf(' ');
        const tail = spaceIdx !== -1 ? after.slice(spaceIdx) : '';
        const next = (before + tail).replace(/^\s+$/, '');
        return next;
      });
    }
    resetCommandMenuState();
  }, [showCommandMenu, slashPosition, setInput, resetCommandMenuState]);

  useEffect(() => {
    if (!selectedProject) {
      setSlashCommands([]);
      setFilteredCommands([]);
      return undefined;
    }

    const abortController = new AbortController();
    const fetchCommands = async () => {
      try {
        const commands: SlashCommand[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const response = await authenticatedFetch('/api/commands/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectKey: selectedProject.fullPath || selectedProject.path,
              ...(commandQuery ? { query: commandQuery } : {}),
              ...(cursor ? { cursor } : {}),
              limit: 100,
            }),
            signal: abortController.signal,
          });
          if (!response.ok) throw new Error('Failed to fetch commands');
          const data = await response.json();
          const page = [
            ...((data.pinned || []) as SlashCommand[]),
            ...((data.builtIn || []) as SlashCommand[]),
            ...((data.custom || []) as SlashCommand[]),
          ];
          page.forEach((command) => {
            const key = getCommandKey(command);
            if (seen.has(key)) return;
            seen.add(key);
            commands.push(command);
          });
          cursor = typeof data.nextCursor === 'string' ? data.nextCursor : undefined;
        } while (cursor && !abortController.signal.aborted);

        if (commandQuery) {
          setFilteredCommands(commands);
        } else {
          const parsedHistory = readCommandHistory(selectedProject.name);
          const sortedCommands = commands.map((command, index) => ({ command, index }))
            .sort((left, right) => {
              const leftPinned = getCommandNamespace(left.command) === 'pinned';
              const rightPinned = getCommandNamespace(right.command) === 'pinned';
              if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
              if (leftPinned && rightPinned) return left.index - right.index;
              const usageDifference = (parsedHistory[right.command.name] || 0)
                - (parsedHistory[left.command.name] || 0);
              return usageDifference || left.command.name.localeCompare(right.command.name);
            })
            .map(({ command }) => command);
          setSlashCommands(sortedCommands);
          setFilteredCommands(sortedCommands);
        }
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') return;
        console.error('Error fetching slash commands:', error);
        if (commandQuery) setFilteredCommands([]);
        else {
          setSlashCommands([]);
          setFilteredCommands([]);
        }
      }
    };

    void fetchCommands();
    return () => abortController.abort();
  }, [commandQuery, selectedProject]);

  useEffect(() => {
    if (!showCommandMenu) {
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  const frequentCommands = useMemo(() => {
    if (!selectedProject || slashCommands.length === 0) {
      return [];
    }

    const parsedHistory = readCommandHistory(selectedProject.name);

    return slashCommands
      .map((command) => ({
        ...command,
        usageCount: parsedHistory[command.name] || 0,
      }))
      .filter((command) => command.usageCount > 0)
      .sort((commandA, commandB) => commandB.usageCount - commandA.usageCount)
      .slice(0, 5);
  }, [selectedProject, slashCommands]);

  const displayedCommands = useMemo(() => {
    return groupCommandsForDisplay(
      filteredCommands,
      commandQuery ? [] : frequentCommands,
    );
  }, [commandQuery, filteredCommands, frequentCommands]);

  useEffect(() => {
    if (!showCommandMenu) {
      return;
    }

    setSelectedCommandIndex((previousIndex) => {
      if (displayedCommands.length === 0) {
        return -1;
      }
      if (previousIndex >= displayedCommands.length) {
        return displayedCommands.length - 1;
      }
      return previousIndex;
    });
  }, [displayedCommands.length, showCommandMenu]);

  const trackCommandUsage = useCallback(
    (command: SlashCommand) => {
      if (!selectedProject) {
        return;
      }

      const parsedHistory = readCommandHistory(selectedProject.name);
      parsedHistory[command.name] = (parsedHistory[command.name] || 0) + 1;
      saveCommandHistory(selectedProject.name, parsedHistory);
    },
    [selectedProject],
  );

  const selectCommandIntoContext = useCallback(
    (command: SlashCommand) => {
      const slashStart = slashPosition >= 0 ? slashPosition : input.length;
      const textBeforeSlash = input.slice(0, slashStart);
      const textAfterSlash = input.slice(slashStart);
      const spaceIndex = textAfterSlash.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterSlash.slice(spaceIndex) : '';
      const newInput = `${textBeforeSlash}${textAfterQuery}`;

      setInput(newInput);
      if (externalInputValueRef) {
        externalInputValueRef.current = newInput;
      }
      setSelectedCommands([command]);
      resetCommandMenuState();

      const caret = textBeforeSlash.length;
      setTimeout(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        try {
          ta.setSelectionRange(caret, caret);
        } catch {
          // Ignore: setSelectionRange throws on unfocused/hidden inputs in some browsers.
        }
      }, 0);
    },
    [externalInputValueRef, input, slashPosition, setInput, resetCommandMenuState, textareaRef],
  );

  const removeSelectedCommand = useCallback((name: string) => {
    setSelectedCommands((previous) => previous.filter((command) => command.name !== name));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [textareaRef]);

  const clearSelectedCommands = useCallback(() => {
    setSelectedCommands([]);
  }, []);

  useEffect(() => {
    setSelectedCommands([]);
  }, [selectedProject?.path]);

  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      trackCommandUsage(command);
      selectCommandIntoContext(command);
    },
    [trackCommandUsage, selectCommandIntoContext],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand | null, index: number, isHover: boolean) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isHover) {
        setSelectedCommandIndex(index);
        return;
      }

      trackCommandUsage(command);
      selectCommandIntoContext(command);
    },
    [selectedProject, trackCommandUsage, selectCommandIntoContext],
  );

  const handleToggleCommandMenu = useCallback(() => {
    const isOpening = !showCommandMenu;
    setShowCommandMenu(isOpening);
    setCommandQuery('');
    setSelectedCommandIndex(-1);

    if (isOpening) {
      setFilteredCommands(slashCommands);
    }

    textareaRef.current?.focus();
  }, [showCommandMenu, slashCommands, textareaRef]);

  const handleCommandInputChange = useCallback(
    (value?: string, cursorPos?: number) => {
      if (value === undefined || cursorPos === undefined) {
        resetCommandMenuState();
        return;
      }

      const textBeforeCursor = value.slice(0, cursorPos);
      const slashMatch = textBeforeCursor.match(/(^|\s)(\/)(\S*)$/);

      if (!slashMatch) {
        resetCommandMenuState();
        return;
      }

      const slashIdx = textBeforeCursor.lastIndexOf('/');
      const query = slashMatch[3] || '';

      setSlashPosition(slashIdx);
      setShowCommandMenu(true);
      setSelectedCommandIndex(query ? -1 : 0);

      clearCommandQueryTimer();
      commandQueryTimerRef.current = window.setTimeout(() => {
        setCommandQuery(query);
      }, COMMAND_QUERY_DEBOUNCE_MS);
    },
    [resetCommandMenuState, clearCommandQueryTimer],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showCommandMenu) {
        return false;
      }

      if (!displayedCommands.length) {
        if (event.key === 'Escape') {
          event.preventDefault();
          resetCommandMenuState();
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex < displayedCommands.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : displayedCommands.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        if (isImeEnterEvent(event)) {
          return false;
        }
        event.preventDefault();
        if (selectedCommandIndex >= 0) {
          selectCommandFromKeyboard(displayedCommands[selectedCommandIndex]);
        } else if (displayedCommands.length > 0) {
          selectCommandFromKeyboard(displayedCommands[0]);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        dismissCommandMenu();
        return true;
      }

      return false;
    },
    [
      showCommandMenu,
      displayedCommands,
      resetCommandMenuState,
      dismissCommandMenu,
      selectCommandFromKeyboard,
      selectedCommandIndex,
    ],
  );

  useEffect(
    () => () => {
      clearCommandQueryTimer();
    },
    [clearCommandQueryTimer],
  );

  return {
    slashCommands,
    slashCommandsCount: slashCommands.length,
    filteredCommands: displayedCommands,
    frequentCommands,
    commandQuery,
    selectedCommands,
    removeSelectedCommand,
    clearSelectedCommands,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    dismissCommandMenu,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  };
}
