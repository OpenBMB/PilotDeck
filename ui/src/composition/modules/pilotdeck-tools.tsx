import type { FrontendModule, SurfaceProps } from '../contracts';

function RemoteLookupRenderer(props: SurfaceProps) {
  return <div className="rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">Remote lookup: {JSON.stringify(props.mode === 'result' ? props.toolResult : props.toolInput)}</div>;
}

const module: FrontendModule = {
  id: 'pilotdeck.tools', slot: 'tools', contract: 'pilotdeck.tools/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1',
  toolRenderers: [{ id: 'pilotdeck.remote-lookup', label: 'Remote lookup', toolNames: ['remote_lookup'], component: RemoteLookupRenderer }],
};
export default module;
