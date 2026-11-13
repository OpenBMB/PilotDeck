import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

const CronSidebarContext = createContext<{
  host: HTMLDivElement | null;
  setHost: (node: HTMLDivElement | null) => void;
  onSelect: () => void;
} | null>(null);

/** The task page owns its state and portals its list into the shell's sidebar. */
export function CronSidebarProvider({ children, onSelect }: { children: ReactNode; onSelect: () => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ host, setHost, onSelect }), [host, onSelect]);
  return <CronSidebarContext.Provider value={value}>{children}</CronSidebarContext.Provider>;
}

export const useCronSidebar = () => useContext(CronSidebarContext);
