/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

export type FindShortcutScope = 'chat' | 'file';

type FindShortcutTarget = {
  scope: FindShortcutScope;
  containerRef: RefObject<HTMLElement | null>;
  onOpen: () => void;
  captureInModal?: boolean;
};

type FindShortcutContextValue = {
  registerTarget: (target: FindShortcutTarget) => () => void;
};

type FindShortcutProviderProps = {
  activeScope: FindShortcutScope;
  children: ReactNode;
};

const FindShortcutContext = createContext<FindShortcutContextValue | null>(null);

function isTargetAvailable(target: FindShortcutTarget): boolean {
  const container = target.containerRef.current;
  if (!container?.isConnected) return false;
  return !container.closest('[aria-hidden="true"], [hidden], [inert]');
}

function eventTargetElement(event: KeyboardEvent): Element | null {
  if (event.target instanceof Element) return event.target;
  return document.activeElement instanceof Element ? document.activeElement : null;
}

function markedScope(target: Element | null): FindShortcutScope | null {
  if (target?.closest('[aria-hidden="true"], [hidden], [inert]')) return null;
  if (target?.closest('[data-file-search-surface]')) return 'file';
  if (target?.closest('[data-chat-search-surface], [data-chat-history-search]')) return 'chat';
  return null;
}

export function FindShortcutProvider({ activeScope, children }: FindShortcutProviderProps) {
  const targetsRef = useRef(new Map<symbol, FindShortcutTarget>());

  const registerTarget = useCallback((target: FindShortcutTarget) => {
    const key = Symbol(target.scope);
    targetsRef.current.set(key, target);
    return () => {
      targetsRef.current.delete(key);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut = (event.ctrlKey || event.metaKey)
        && event.key.toLowerCase() === 'f';
      if (!isFindShortcut) return;

      const targetElement = eventTargetElement(event);
      const targets = Array.from(targetsRef.current.values())
        .reverse()
        .filter(isTargetAvailable);
      const modalOverlay = document.querySelector<HTMLElement>('[data-modal-overlay]');

      let eligibleTargets = targets;
      if (modalOverlay) {
        eligibleTargets = targets.filter((target) => {
          const container = target.containerRef.current;
          return Boolean(
            target.captureInModal
            || (container && modalOverlay.contains(container)),
          );
        });
        if (eligibleTargets.length === 0) return;
      }

      const containingTarget = targetElement
        ? eligibleTargets.find((target) => target.containerRef.current?.contains(targetElement))
        : undefined;
      const explicitScope = markedScope(targetElement);
      let shortcutTarget = containingTarget;
      if (!shortcutTarget && explicitScope) {
        shortcutTarget = eligibleTargets.find((target) => target.scope === explicitScope);
      } else if (!shortcutTarget && modalOverlay) {
        shortcutTarget = eligibleTargets.find((target) => target.captureInModal)
          ?? eligibleTargets[0];
      } else if (!shortcutTarget) {
        shortcutTarget = eligibleTargets.find((target) => target.scope === activeScope);
      }

      // Do not fall through to another application surface. If the active
      // scope has no searchable target, retain the browser's native find.
      if (!shortcutTarget) return;

      event.preventDefault();
      event.stopPropagation();
      shortcutTarget.onOpen();
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [activeScope]);

  const value = useMemo(() => ({ registerTarget }), [registerTarget]);

  return (
    <FindShortcutContext.Provider value={value}>
      {children}
    </FindShortcutContext.Provider>
  );
}

export function useRegisterFindShortcutTarget({
  scope,
  containerRef,
  enabled = true,
  onOpen,
  captureInModal = false,
}: FindShortcutTarget & { enabled?: boolean }) {
  const controller = useContext(FindShortcutContext);

  useEffect(() => {
    if (!controller || !enabled) return undefined;
    return controller.registerTarget({
      scope,
      containerRef,
      onOpen,
      captureInModal,
    });
  }, [captureInModal, containerRef, controller, enabled, onOpen, scope]);
}
