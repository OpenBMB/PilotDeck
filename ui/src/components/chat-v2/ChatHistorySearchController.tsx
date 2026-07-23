/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type RegisteredSearchControls = {
  openSearch: () => void;
  closeSearch: () => void;
};

export type ChatHistorySearchPresentation = {
  query: string;
  onQueryChange: (value: string) => void;
  matchCount: number;
  activeMatchIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  inputRef: { current: HTMLInputElement | null };
};

type RegisterChatHistorySearchControlsOptions = RegisteredSearchControls & {
  isOpen: boolean;
  query: string;
  setQuery: (value: string) => void;
  matches: unknown[];
  activeMatchIndex: number;
  goToPrevious: () => void;
  goToNext: () => void;
  inputRef: { current: HTMLInputElement | null };
};

type ChatHistorySearchControllerValue = {
  available: boolean;
  isOpen: boolean;
  presentation: ChatHistorySearchPresentation | null;
  openSearch: () => void;
  closeSearch: () => void;
  registerControls: (controls: RegisteredSearchControls) => () => void;
  reportOpenState: (isOpen: boolean) => void;
  reportPresentation: (presentation: ChatHistorySearchPresentation) => void;
};

const ChatHistorySearchControllerContext = createContext<ChatHistorySearchControllerValue | null>(null);

export function ChatHistorySearchControllerProvider({ children }: { children: ReactNode }) {
  const controlsRef = useRef<RegisteredSearchControls | null>(null);
  const [available, setAvailable] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [presentation, setPresentation] = useState<ChatHistorySearchPresentation | null>(null);

  const registerControls = useCallback((controls: RegisteredSearchControls) => {
    controlsRef.current = controls;
    setAvailable(true);

    return () => {
      if (controlsRef.current !== controls) return;
      controlsRef.current = null;
      setAvailable(false);
      setIsOpen(false);
      setPresentation(null);
    };
  }, []);

  const reportOpenState = useCallback((nextIsOpen: boolean) => {
    setIsOpen(nextIsOpen);
  }, []);

  const reportPresentation = useCallback((nextPresentation: ChatHistorySearchPresentation) => {
    setPresentation(nextPresentation);
  }, []);

  const openSearch = useCallback(() => {
    if (!controlsRef.current) return;
    setIsOpen(true);
    controlsRef.current.openSearch();
  }, []);

  const closeSearch = useCallback(() => {
    setIsOpen(false);
    controlsRef.current?.closeSearch();
  }, []);

  const value = useMemo<ChatHistorySearchControllerValue>(() => ({
    available,
    isOpen,
    presentation,
    openSearch,
    closeSearch,
    registerControls,
    reportOpenState,
    reportPresentation,
  }), [
    available,
    closeSearch,
    isOpen,
    openSearch,
    presentation,
    registerControls,
    reportOpenState,
    reportPresentation,
  ]);

  return (
    <ChatHistorySearchControllerContext.Provider value={value}>
      {children}
    </ChatHistorySearchControllerContext.Provider>
  );
}

export function useChatHistorySearchController(): ChatHistorySearchControllerValue {
  const controller = useContext(ChatHistorySearchControllerContext);
  if (!controller) {
    throw new Error('useChatHistorySearchController must be used within ChatHistorySearchControllerProvider');
  }
  return controller;
}

export function useRegisterChatHistorySearchControls({
  isOpen,
  openSearch,
  closeSearch,
  query,
  setQuery,
  matches,
  activeMatchIndex,
  goToPrevious,
  goToNext,
  inputRef,
}: RegisterChatHistorySearchControlsOptions): boolean {
  const controller = useContext(ChatHistorySearchControllerContext);
  const registerControls = controller?.registerControls;
  const reportOpenState = controller?.reportOpenState;
  const reportPresentation = controller?.reportPresentation;
  const presentationActionsRef = useRef({ setQuery, goToPrevious, goToNext });
  presentationActionsRef.current = { setQuery, goToPrevious, goToNext };

  useEffect(() => {
    if (!registerControls) return undefined;
    return registerControls({ openSearch, closeSearch });
  }, [closeSearch, openSearch, registerControls]);

  useEffect(() => {
    reportOpenState?.(isOpen);
  }, [isOpen, reportOpenState]);

  useEffect(() => {
    reportPresentation?.({
      query,
      onQueryChange: (value) => presentationActionsRef.current.setQuery(value),
      matchCount: matches.length,
      activeMatchIndex,
      onPrevious: () => presentationActionsRef.current.goToPrevious(),
      onNext: () => presentationActionsRef.current.goToNext(),
      inputRef,
    });
  }, [
    activeMatchIndex,
    inputRef,
    matches.length,
    query,
    reportPresentation,
  ]);

  return Boolean(controller);
}
