type SessionPresentationInput = {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  tag?: string;
};

export type LegacySessionPresentation = {
  title: string;
  summary: string;
  name: string;
  tag?: string;
};

const CRON_SESSION_PREFIX = "cron:";
const CRON_TITLE_PREFIX = "[Cron] ";

export function mapLegacySessionPresentation(
  session: SessionPresentationInput,
): LegacySessionPresentation {
  const baseLabel = session.summary || session.firstPrompt || session.sessionId;
  const isCronSession = session.sessionId.startsWith(CRON_SESSION_PREFIX);
  const label = isCronSession && !baseLabel.startsWith(CRON_TITLE_PREFIX)
    ? `${CRON_TITLE_PREFIX}${baseLabel}`
    : baseLabel;

  return {
    title: label,
    summary: label,
    name: label,
    tag: session.tag ?? (isCronSession ? "cron" : undefined),
  };
}
