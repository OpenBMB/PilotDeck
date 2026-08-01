import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentGroup } from '../types/group';
import { api } from '../utils/api';

const GROUP_LIST_POLL_MS = 2_500;

export function useAgentGroups() {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [isLoadingGroups, setIsLoadingGroups] = useState(true);
  const mountedRef = useRef(true);

  const refreshGroups = useCallback(async (showLoading = false) => {
    if (showLoading) setIsLoadingGroups(true);
    try {
      const response = await api.groups();
      const payload = await response.json().catch(() => ({})) as { groups?: AgentGroup[] };
      if (!response.ok) throw new Error((payload as { error?: string }).error || '加载群组失败');
      if (mountedRef.current) setGroups(Array.isArray(payload.groups) ? payload.groups : []);
    } catch {
      // Keep the last successful snapshot when a background poll is interrupted.
    } finally {
      if (showLoading && mountedRef.current) setIsLoadingGroups(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshGroups(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshGroups(false);
    }, GROUP_LIST_POLL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refreshGroups]);

  const createGroup = useCallback(async (input: {
    title: string;
    projectName: string;
    triggerMode: 'auto' | 'mentions';
    muted: boolean;
  }): Promise<AgentGroup> => {
    const response = await api.createGroup(input);
    const payload = await response.json().catch(() => ({})) as { group?: AgentGroup; error?: string };
    if (!response.ok || !payload.group) throw new Error(payload.error || '创建群组失败');
    setGroups((previous) => [payload.group!, ...previous.filter((group) => group.id !== payload.group!.id)]);
    return payload.group;
  }, []);

  return {
    groups,
    isLoadingGroups,
    refreshGroups,
    createGroup,
  };
}
