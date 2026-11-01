import { useEffect, useState } from 'react';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { useGlobalSearch, type GlobalSearchResult } from './GlobalSearchContext';
import type { RecentFile } from './recentFiles';

const EMPTY: RecentFile[] = [];

// Only validate saved visits while the empty-query view is visible. HEAD requests
// reuse the file endpoint's project/permission checks without reading file bodies.
export function useRecentFileResults(projects: Project[], projectName: string, enabled: boolean) {
  const search = useGlobalSearch();
  const files = search?.recentFiles || EMPTY;
  const forgetFiles = search?.forgetFiles;
  const [state, setState] = useState<{
    files: RecentFile[]; projects: Project[]; projectName: string; items: GlobalSearchResult[];
  } | null>(null);
  const current = enabled && state?.files === files && state.projects === projects && state.projectName === projectName;

  useEffect(() => {
    if (!enabled || !files.length) { setState(null); return; }
    const controller = new AbortController();
    const candidates = files.flatMap(file => {
      const project = projects.find(item => item.name === file.projectName && item.capabilities?.files !== false);
      return project && (!projectName || project.name === projectName) ? [{ file, project }] : [];
    });
    void (async () => {
      const items: GlobalSearchResult[] = [];
      const stale: RecentFile[] = [];
      for (let offset = 0; offset < candidates.length && items.length < 5; offset += 4) {
        const batch = await Promise.all(candidates.slice(offset, offset + 4).map(async ({ file, project }) => {
          try {
            const response = await api.fileMetadata(project.name, file.path, { signal: controller.signal });
            if (response.status === 403 || response.status === 404) stale.push(file);
            return response.ok ? { id: 'recent-file:' + JSON.stringify([project.name, file.identityPath || file.path]),
              kind: 'files' as const, project, path: file.path, title: file.path.split('/').pop() || file.path,
              timestamp: file.visitedAt } : null;
          } catch { return null; }
        }));
        if (controller.signal.aborted) return;
        items.push(...batch.filter((item): item is NonNullable<typeof item> => item !== null));
      }
      if (controller.signal.aborted) return;
      setState({ files, projects, projectName, items: items.slice(0, 5) });
      if (stale.length) forgetFiles?.(stale);
    })();
    return () => controller.abort();
  }, [enabled, files, projects, projectName, forgetFiles]);

  return { items: current ? state.items : [], loading: Boolean(enabled && files.length && !current) };
}
