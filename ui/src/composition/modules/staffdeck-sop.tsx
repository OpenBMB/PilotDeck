import SopWaitBanner from '../../components/chat-v2/SopWaitBanner';
import { useAuth } from '../../components/auth';
import { useTranslation } from 'react-i18next';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { ProfileTextSetting } from './shared';
import SharedSkillsPage from '../../../plugins/staffdeck-sop/src/vendor/SkillsPage';
import SharedDistillPage from '../../../plugins/staffdeck-sop/src/vendor/DistillPage';
import { PilotDeckDistillPageProvider, PilotDeckSkillsPageProvider } from '../../../plugins/staffdeck-sop/src/vendor/skills-host-adapter';
import StaffDeckLocaleBoundary from './staffdeck/StaffDeckLocaleBoundary';
import { PublishRuntimeProvider } from './staffdeck/publish-runtime-context';
import PublishRuntimeStatus from './staffdeck/PublishRuntimeStatus';
import { StaffDeckHostBinding } from './staffdeck-host-binding';
import { PublicApprovalInboxMount } from './staffdeck/public-approval-inbox-mount';
import FormalSopApprovalInbox from '../../../plugins/staffdeck-sop/src/vendor/FormalSopApprovalInbox';
import { useCallback, useState } from 'react';

const BUILD_MARKER = 'staffdeck.sop.ui/v1';
const noop = () => {};

function FormalSopPage() {
  const { user } = useAuth();
  const currentUser = user ? { id: String(user.id ?? ''), username: user.username, is_admin: user.is_admin === true } : undefined;
  return <StaffDeckHostBinding><StaffDeckLocaleBoundary><PublishRuntimeProvider><PublishRuntimeStatus /><PilotDeckSkillsPageProvider><SharedSkillsPage currentUser={currentUser} /></PilotDeckSkillsPageProvider></PublishRuntimeProvider></StaffDeckLocaleBoundary></StaffDeckHostBinding>;
}

function FormalSopDistillPage() {
  const { user } = useAuth();
  const currentUser = user ? { id: String(user.id ?? ''), username: user.username, is_admin: user.is_admin === true } : undefined;
  return <StaffDeckHostBinding><StaffDeckLocaleBoundary><PublishRuntimeProvider><PublishRuntimeStatus /><PilotDeckDistillPageProvider><SharedDistillPage currentUser={currentUser} /></PilotDeckDistillPageProvider></PublishRuntimeProvider></StaffDeckLocaleBoundary></StaffDeckHostBinding>;
}

function SopExtension({ sessionId, projectKey = 'general', refreshKey, disabled, onPrepared, onError, host }: SurfaceProps) {
  const approvalInput = host?.approval;
  const [externalWait, setExternalWait] = useState(false);
  const onWaitKind = useCallback((kind: 'handoff' | 'external_task' | null) => setExternalWait(kind === 'external_task'), []);
  return <>
    <SopWaitBanner sessionKey={sessionId ?? ''} projectKey={projectKey} refreshKey={refreshKey ?? sessionId ?? ''}
      disabled={disabled} onPrepared={onPrepared ?? noop} onError={onError ?? noop}
      allowedWaitKind="external_task" onWaitKind={onWaitKind} />
    {sessionId ? <PublicApprovalInboxMount scope={{ sessionKey: sessionId, projectKey }}
      readApproverBearer={approvalInput?.readApproverBearer} Inbox={approvalInput?.Inbox}
      refreshKey={`${refreshKey ?? ''}:${approvalInput?.refreshKey ?? ''}`} disabled={disabled} hidden={externalWait}
      onPrepared={onPrepared} onError={onError} /> : null}
  </>;
}

export function SopPermissionPanel(props: SurfaceProps) {
  const { t } = useTranslation('staffdeck');
  const request = props.request ?? props.permissionRequest as { requestId?: string; toolName?: string } | undefined;
  const decide = (allow: boolean) => {
    if (!request?.requestId || !props.onDecision) return;
    props.onDecision(request.requestId, { allow, message: allow ? t('sop.approved') : t('sop.rejected') });
  };
  return <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
    <p>{t('sop.approvalRequested', { toolName: request?.toolName ?? t('sop.defaultApproval') })}</p>
    <div className="mt-2 flex gap-2">
      <button type="button" className="rounded bg-amber-700 px-2 py-1 text-white disabled:opacity-50" disabled={!request?.requestId || !props.onDecision} onClick={() => decide(true)}>{t('sop.approve')}</button>
      <button type="button" className="rounded border border-amber-700 px-2 py-1 disabled:opacity-50" disabled={!request?.requestId || !props.onDecision} onClick={() => decide(false)}>{t('sop.reject')}</button>
    </div>
  </div>;
}

const module: FrontendModule = {
  id: 'staffdeck.sop', slot: 'sop', contract: 'sop.lifecycle/v2', source: 'staffdeck', frontendApiVersion: 'frontend-module/v1',
  buildMarker: BUILD_MARKER,
  requires: ['agentLoop'],
  pages: [
    { id: 'sop', path: '/sop', label: 'Workflow', labelKey: 'staffdeck:nav.workflow', component: FormalSopPage },
    { id: 'sop-distill', path: '/sop/distill', label: 'Edit workflow', labelKey: 'staffdeck:nav.workflow', component: FormalSopDistillPage },
  ],
  settings: [{ id: 'sop-default-workflow', settingsSection: 'sop', label: 'Workflow', labelKey: 'staffdeck:nav.workflow', component: () => <SopProfileSetting /> }],
  chatExtensions: [{ id: 'sop-wait', label: 'SOP wait state', component: SopExtension, requiresRuntime: true }],
  approvalInbox: FormalSopApprovalInbox,
  permissionPanels: [{ id: 'sop-approval', label: 'SOP approval', toolNames: ['operator_approval'], component: SopPermissionPanel, requiresRuntime: true }],
};
export default module;

function SopProfileSetting() {
  const { t } = useTranslation('staffdeck');
  return <ProfileTextSetting slot="sop" field="defaultSopId" label={t('settings.defaultWorkflow')} description={t('settings.defaultWorkflowDescription')} />;
}
