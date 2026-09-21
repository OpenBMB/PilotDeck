import SopWaitBanner from '../../components/chat-v2/SopWaitBanner';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { ModulePage, ProfileTextSetting } from './shared';

const BUILD_MARKER = 'staffdeck.sop.ui/v1';

function SopPage(props: SurfaceProps) {
  return <ModulePage {...props} title="Workflow" detail="StaffDeck SOP lifecycle/v2 is selected by the backend profile."><span className="sr-only" data-module-build-marker={BUILD_MARKER} /></ModulePage>;
}

function SopExtension({ sessionId, projectKey = 'general', refreshKey, disabled, onPrepared, onError }: SurfaceProps) {
  return <SopWaitBanner
    sessionKey={sessionId ?? ''}
    projectKey={projectKey}
    refreshKey={refreshKey ?? sessionId ?? ''}
    disabled={disabled}
    onPrepared={onPrepared ?? (() => {})}
    onError={onError ?? (() => {})}
  />;
}

export function SopPermissionPanel(props: SurfaceProps) {
  const request = props.request ?? props.permissionRequest as { requestId?: string; toolName?: string } | undefined;
  const decide = (allow: boolean) => {
    if (!request?.requestId || !props.onDecision) return;
    props.onDecision(request.requestId, { allow, message: allow ? 'Workflow approved' : 'Workflow rejected' });
  };
  return <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
    <p>Workflow approval requested: {request?.toolName ?? 'operator approval'}</p>
    <div className="mt-2 flex gap-2">
      <button type="button" className="rounded bg-amber-700 px-2 py-1 text-white disabled:opacity-50" disabled={!request?.requestId || !props.onDecision} onClick={() => decide(true)}>Approve</button>
      <button type="button" className="rounded border border-amber-700 px-2 py-1 disabled:opacity-50" disabled={!request?.requestId || !props.onDecision} onClick={() => decide(false)}>Reject</button>
    </div>
  </div>;
}

const module: FrontendModule = {
  id: 'staffdeck.sop', slot: 'sop', contract: 'sop.lifecycle/v2', source: 'staffdeck', frontendApiVersion: 'frontend-module/v1',
  buildMarker: BUILD_MARKER,
  requires: ['agentLoop'],
  pages: [{ id: 'sop', path: '/sop', label: 'Workflow', component: SopPage }],
  settings: [{ id: 'sop-default-workflow', settingsSection: 'sop', label: 'Workflow', component: () => <ProfileTextSetting slot="sop" field="defaultSopId" label="Default workflow" description="The SOP selected for new workflow runs." /> }],
  chatExtensions: [{ id: 'sop-wait', label: 'SOP wait state', component: SopExtension }],
  permissionPanels: [{ id: 'sop-approval', label: 'SOP approval', toolNames: ['operator_approval'], component: SopPermissionPanel }],
};
export default module;
