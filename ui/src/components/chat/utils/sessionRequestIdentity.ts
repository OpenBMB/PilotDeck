import { getSessionRequestParams, isReadOnlySession, type Project, type ProjectSession } from '../../../types/app';

export function getSessionRequestIdentity(project: Project | null, session: ProjectSession | null) {
  if (!project || !session) return null;
  const projectName = project.name;
  const projectPath = project.fullPath || project.path || '';
  const sessionId = session.id;
  const readOnly = isReadOnlySession(session);
  const params = getSessionRequestParams(session);
  const transcript = [projectName, projectPath, sessionId, params.sessionKind,
    params.parentSessionId, params.relativeTranscriptPath];
  return {
    key: JSON.stringify([...transcript, readOnly]),
    transcriptKey: JSON.stringify(transcript),
    sessionId, projectName, readOnly,
    options: { provider: 'pilotdeck' as const, projectName, projectPath, ...params },
  };
}

export type SessionRequestIdentity = NonNullable<ReturnType<typeof getSessionRequestIdentity>>;
