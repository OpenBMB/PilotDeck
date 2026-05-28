import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import Fuse from 'fuse.js';
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
  [key: string]: unknown;
}

interface UseSlashCommandsOptions {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onExecuteCommand: (command: SlashCommand, rawInput?: string) => void | Promise<void>;
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

const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  Boolean(value) && typeof (value as Promise<unknown>).then === 'function';

export function useSlashCommands({
  selectedProject,
  input,
  setInput,
  textareaRef,
  onExecuteCommand,
}: UseSlashCommandsOptions) {
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
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
    const fetchCommands = async () => {
      if (!selectedProject) {
        setSlashCommands([]);
        setFilteredCommands([]);
        return;
      }

      try {
        const response = await authenticatedFetch('/api/commands/list', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectPath: selectedProject.path,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to fetch commands');
        }

        const data = await response.json();
        const allCommands: SlashCommand[] = [
          ...((data.builtIn || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'built-in',
          })),
          ...((data.custom || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'custom',
          })),
        ];

        // Pinned commands always come first in fixed server-defined order;
        // backend returns them as `data.pinned` for that exact ordering.
        // Other commands fall back to usage-history sort.
        const pinnedOrderIndex = new Map<string, number>();
        ((data.pinned || []) as SlashCommand[]).forEach((command, index) => {
          pinnedOrderIndex.set(command.name, index);
        });

        const parsedHistory = readCommandHistory(selectedProject.name);
        const sortedCommands = [...allCommands].sort((commandA, commandB) => {
          const aPinnedIdx = pinnedOrderIndex.has(commandA.name)
            ? (pinnedOrderIndex.get(commandA.name) as number)
            : -1;
          const bPinnedIdx = pinnedOrderIndex.has(commandB.name)
            ? (pinnedOrderIndex.get(commandB.name) as number)
            : -1;
          if (aPinnedIdx !== -1 || bPinnedIdx !== -1) {
            if (aPinnedIdx === -1) return 1;
            if (bPinnedIdx === -1) return -1;
            return aPinnedIdx - bPinnedIdx;
          }
          const commandAUsage = parsedHistory[commandA.name] || 0;
          const commandBUsage = parsedHistory[commandB.name] || 0;
          return commandBUsage - commandAUsage;
        });

        setSlashCommands(sortedCommands);
      } catch (error) {
        console.error('Error fetching slash commands:', error);
        setSlashCommands([]);
      }
    };

    fetchCommands();
  }, [selectedProject]);

  useEffect(() => {
    if (!showCommandMenu) {
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  const fuse = useMemo(() => {
    if (!slashCommands.length) {
      return null;
    }

    return new Fuse(slashCommands, {
      keys: [
        { name: 'name', weight: 2 },
        { name: 'description', weight: 1 },
      ],
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 1,
    });
  }, [slashCommands]);

  useEffect(() => {
    if (!commandQuery) {
      setFilteredCommands(slashCommands);
      return;
    }

    if (!fuse) {
      setFilteredCommands([]);
      return;
    }

    const results = fuse.search(commandQuery);
    setFilteredCommands(results.map((result) => result.item));
  }, [commandQuery, slashCommands, fuse]);

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

  // Insert the picked command name into the textarea and leave the caret right
  // after `<command> `. We DO NOT auto-submit — the user reviews/edits args
  // and presses Enter themselves, mirroring how the TUI behaves and avoiding
  // surprise sends (e.g. /add-project with no path runs blindly).
  //
  // The replacement spans from the active `/` to the next whitespace so a
  // partial query like `hello /skill_inst` becomes `hello /skill_install ` and
  // any trailing text after the query is preserved.
  const insertCommandIntoInput = useCallback(
    (command: SlashCommand) => {
      // Fall back to slash-prepend when no active slashPosition exists (e.g.
      // mouse click without prior typing). Keep existing input intact.
      const slashStart = slashPosition >= 0 ? slashPosition : input.length;
      const textBeforeSlash = input.slice(0, slashStart);
      const textAfterSlash = input.slice(slashStart);
      const spaceIndex = textAfterSlash.indexOf(' ');
      const textAfterQuery =
        spaceIndex !== -1 ? textAfterSlash.slice(spaceIndex) : '';
      const head = `${textBeforeSlash}${command.name} `;
      const newInput = `${head}${textAfterQuery}`;

      setInput(newInput);
      resetCommandMenuState();

      // Defer focus + caret placement until after React commits the new input
      // value; otherwise selectionStart points into stale text.
      const caret = head.length;
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
    [input, slashPosition, setInput, resetCommandMenuState, textareaRef],
  );

  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      insertCommandIntoInput(command);
    },
    [insertCommandIntoInput],
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
      insertCommandIntoInput(command);
    },
    [selectedProject, trackCommandUsage, insertCommandIntoInput],
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
    () => {
      resetCommandMenuState();
    },
    [resetCommandMenuState],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showCommandMenu) {
        return false;
      }

      if (!filteredCommands.length) {
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
          previousIndex < filteredCommands.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredCommands.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        if (isImeEnterEvent(event)) {
          return false;
        }
        event.preventDefault();
        if (selectedCommandIndex >= 0) {
          selectCommandFromKeyboard(filteredCommands[selectedCommandIndex]);
        } else if (filteredCommands.length > 0) {
          selectCommandFromKeyboard(filteredCommands[0]);
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
    [showCommandMenu, filteredCommands, dismissCommandMenu, selectCommandFromKeyboard, selectedCommandIndex],
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
    filteredCommands,
    frequentCommands,
    commandQuery,
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
