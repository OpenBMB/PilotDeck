import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import Fuse from 'fuse.js';
import { authenticatedFetch } from '../../../utils/api';
import { isImeEnterEvent } from '../../../utils/ime';
import { safeLocalStorage } from '../utils/chatStorage';
import type { Project } from '../../../types/app';

export interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  displayNamespace?: string;
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

const normalizeCommandNamespace = (namespace: unknown) =>
  namespace === 'built-in' ? 'builtin' : typeof namespace === 'string' && namespace ? namespace : 'other';

const getCommandNamespace = (command: SlashCommand) =>
  normalizeCommandNamespace(
    command.namespace === 'pinned' || command.namespace === 'frequent'
      ? command.type
      : command.namespace || command.type,
  );

const getCommandDisplayNamespace = (command: SlashCommand) =>
  normalizeCommandNamespace(command.displayNamespace || command.namespace || command.type);

const getCommandKey = (command: SlashCommand) =>
  `${command.name}::${getCommandNamespace(command)}::${command.path || ''}`;

const getLegacyCommandKeys = (command: SlashCommand): string[] => {
  const currentKey = getCommandKey(command);
  const rawNamespace = command.namespace || command.type || 'other';
  const rawKey = `${command.name}::${rawNamespace}::${command.path || ''}`;
  const keys = new Set<string>();

  if (rawKey !== currentKey) {
    keys.add(rawKey);
  }
  if (getCommandNamespace(command) === 'builtin') {
    keys.add(`${command.name}::built-in::${command.path || ''}`);
  }

  return [...keys].filter((key) => key !== currentKey);
};

const getCommandUsage = (history: Record<string, number>, command: SlashCommand) =>
  [getCommandKey(command), ...getLegacyCommandKeys(command), command.name].reduce(
    (usage, key) => usage + (history[key] || 0),
    0,
  );

const getPinnedMatchKeys = (command: SlashCommand): string[] => {
  const normalizedKey = getCommandKey(command);
  if (getCommandDisplayNamespace(command) !== 'pinned') {
    return [normalizedKey];
  }

  return [
    normalizedKey,
    `${command.name}::builtin::${command.path || ''}`,
    `${command.name}::custom::${command.path || ''}`,
    `${command.name}::project::${command.path || ''}`,
    `${command.name}::user::${command.path || ''}`,
    `${command.name}::other::${command.path || ''}`,
  ];
};

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
    const namespace = getCommandDisplayNamespace(command);
    const group = groups.get(namespace) || [];
    group.push(command);
    groups.set(namespace, group);
  }

  if (frequentCommands.length > 0) {
    groups.set(
      'frequent',
      frequentCommands.map((command) => ({
        ...command,
        displayNamespace: 'frequent',
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

export function removeActiveSlashQueryForTest(input: string, slashPosition: number): string {
  if (slashPosition < 0 || slashPosition >= input.length || input[slashPosition] !== '/') {
    return input;
  }

  const before = input.slice(0, slashPosition);
  const after = input.slice(slashPosition);
  const whitespaceIndex = after.search(/\s/);
  const tail = whitespaceIndex !== -1 ? after.slice(whitespaceIndex) : '';

  if (!tail) {
    return before.replace(/\s+$/, '');
  }

  if (!before.trim()) {
    return tail.trimStart();
  }

  if (/^\r?\n/.test(tail)) {
    return `${before.replace(/[ \t]+$/, '')}${tail}`;
  }

  if (/[ \t]$/.test(before) && /^[ \t]/.test(tail)) {
    return `${before}${tail.replace(/^[ \t]+/, '')}`;
  }

  return `${before}${tail}`;
}

export function buildSlashCommandInsertion(
  input: string,
  slashPosition: number,
  commandName: string,
): { value: string; caret: number } {
  if (slashPosition < 0 || slashPosition >= input.length || input[slashPosition] !== '/') {
    const separator = input.length > 0 && !/\s$/.test(input) ? ' ' : '';
    const value = `${input}${separator}${commandName} `;
    return { value, caret: value.length };
  }

  const before = input.slice(0, slashPosition);
  const afterSlash = input.slice(slashPosition);
  const whitespaceIndex = afterSlash.search(/\s/);
  const tail =
    whitespaceIndex !== -1 ? afterSlash.slice(whitespaceIndex).replace(/^[ \t]+/, '') : '';
  const separator = tail && /^\r?\n/.test(tail) ? '' : ' ';
  const head = `${before}${commandName}${separator}`;
  return {
    value: `${head}${tail}`,
    caret: head.length,
  };
}

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
  const [slashPosition, setSlashPosition] = useState(-1);
  const [commandHistoryRevision, setCommandHistoryRevision] = useState(0);

  const resetCommandMenuState = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery('');
    setSelectedCommandIndex(-1);
  }, []);

  const dismissCommandMenu = useCallback(() => {
    if (showCommandMenu && slashPosition >= 0) {
      setInput((prev) => {
        const next = removeActiveSlashQueryForTest(prev, slashPosition);
        if (externalInputValueRef) {
          externalInputValueRef.current = next;
        }
        return next;
      });
    }
    resetCommandMenuState();
  }, [externalInputValueRef, showCommandMenu, slashPosition, setInput, resetCommandMenuState]);

  useEffect(() => {
    let isStale = false;

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
        if (isStale) {
          return;
        }
        const allCommands: SlashCommand[] = [
          ...((data.builtIn || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'builtin',
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
          getPinnedMatchKeys(command).forEach((key) => {
            if (!pinnedOrderIndex.has(key)) {
              pinnedOrderIndex.set(key, index);
            }
          });
        });

        const parsedHistory = readCommandHistory(selectedProject.name);
        const sortedCommands = [...allCommands].sort((commandA, commandB) => {
          const commandAKey = getCommandKey(commandA);
          const commandBKey = getCommandKey(commandB);
          const aPinnedIdx = pinnedOrderIndex.has(commandAKey)
            ? (pinnedOrderIndex.get(commandAKey) as number)
            : -1;
          const bPinnedIdx = pinnedOrderIndex.has(commandBKey)
            ? (pinnedOrderIndex.get(commandBKey) as number)
            : -1;
          if (aPinnedIdx !== -1 || bPinnedIdx !== -1) {
            if (aPinnedIdx === -1) return 1;
            if (bPinnedIdx === -1) return -1;
            return aPinnedIdx - bPinnedIdx;
          }
          const commandAUsage = getCommandUsage(parsedHistory, commandA);
          const commandBUsage = getCommandUsage(parsedHistory, commandB);
          return commandBUsage - commandAUsage;
        });

        setSlashCommands(sortedCommands);
      } catch (error) {
        if (isStale) {
          return;
        }
        console.error('Error fetching slash commands:', error);
        setSlashCommands([]);
      }
    };

    fetchCommands();

    return () => {
      isStale = true;
    };
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
        usageCount: getCommandUsage(parsedHistory, command),
      }))
      .filter((command) => command.usageCount > 0 && getCommandDisplayNamespace(command) !== 'pinned')
      .sort((commandA, commandB) => commandB.usageCount - commandA.usageCount)
      .slice(0, 5);
  }, [commandHistoryRevision, selectedProject, slashCommands]);

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
      if (previousIndex < 0) {
        return 0;
      }
      if (previousIndex >= displayedCommands.length) {
        return displayedCommands.length - 1;
      }
      return previousIndex;
    });
  }, [displayedCommands, showCommandMenu]);

  const trackCommandUsage = useCallback(
    (command: SlashCommand) => {
      if (!selectedProject) {
        return;
      }

      const parsedHistory = readCommandHistory(selectedProject.name);
      const commandKey = getCommandKey(command);
      parsedHistory[commandKey] = getCommandUsage(parsedHistory, command) + 1;
      getLegacyCommandKeys(command).forEach((legacyKey) => {
        delete parsedHistory[legacyKey];
      });
      delete parsedHistory[command.name];
      saveCommandHistory(selectedProject.name, parsedHistory);
      setCommandHistoryRevision((revision) => revision + 1);
    },
    [selectedProject],
  );

  // Insert the picked command name into the textarea and leave the caret right
  // after `<command> `. We DO NOT auto-submit — the user reviews/edits args
  // and presses Enter themselves, mirroring how the TUI behaves and avoiding
  // surprise sends from slash suggestions that still need arguments.
  //
  // The replacement spans from the active `/` to the next whitespace so a
  // partial query like `hello /skill_inst` becomes `hello /skill_install ` and
  // any trailing text after the query is preserved.
  const insertCommandIntoInput = useCallback(
    (command: SlashCommand) => {
      const { value: newInput, caret } = buildSlashCommandInsertion(
        input,
        slashPosition,
        command.name,
      );

      setInput(newInput);
      if (externalInputValueRef) {
        externalInputValueRef.current = newInput;
      }
      resetCommandMenuState();

      // Defer focus + caret placement until after React commits the new input
      // value; otherwise selectionStart points into stale text.
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

  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      trackCommandUsage(command);
      insertCommandIntoInput(command);
    },
    [trackCommandUsage, insertCommandIntoInput],
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

      setCommandQuery(query);
    },
    [resetCommandMenuState],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showCommandMenu) {
        return false;
      }

      if (!displayedCommands.length) {
        if (event.key === 'Escape') {
          event.preventDefault();
          dismissCommandMenu();
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

  return {
    slashCommands,
    slashCommandsCount: slashCommands.length,
    filteredCommands: displayedCommands,
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
