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

type ChatHistorySearchControllerValue = {
  available: boolean;
  isOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  registerControls: (controls: RegisteredSearchControls) => () => void;
  reportOpenState: (isOpen: boolean) => void;
};

const ChatHistorySearchControllerContext = createContext<ChatHistorySearchControllerValue | null>(null);

export function ChatHistorySearchControllerProvider({ children }: { children: ReactNode }) {
  const controlsRef = useRef<RegisteredSearchControls | null>(null);
  const [available, setAvailable] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const registerControls = useCallback((controls: RegisteredSearchControls) => {
    controlsRef.current = controls;
    setAvailable(true);

    return () => {
      if (controlsRef.current !== controls) return;
      controlsRef.current = null;
      setAvailable(false);
      setIsOpen(false);
    };
  }, []);

  const reportOpenState = useCallback((nextIsOpen: boolean) => {
    setIsOpen(nextIsOpen);
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
    openSearch,
    closeSearch,
    registerControls,
    reportOpenState,
  }), [available, closeSearch, isOpen, openSearch, registerControls, reportOpenState]);

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
}: RegisteredSearchControls & { isOpen: boolean }) {
  const controller = useContext(ChatHistorySearchControllerContext);
  const registerControls = controller?.registerControls;
  const reportOpenState = controller?.reportOpenState;

  useEffect(() => {
    if (!registerControls) return undefined;
    return registerControls({ openSearch, closeSearch });
  }, [closeSearch, openSearch, registerControls]);

  useEffect(() => {
    reportOpenState?.(isOpen);
  }, [isOpen, reportOpenState]);
}
