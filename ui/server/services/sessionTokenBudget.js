import { getSessionTokenBudget, withPilotDeckGatewayReadRetry } from '../pilotdeck-bridge.js';
import { extractProjectDirectory } from '../projects.js';

export async function readSessionTokenBudget(projectName, sessionId) {
    const current = getSessionTokenBudget(sessionId);
    if (!current.unknown) return current;
    const projectKey = await extractProjectDirectory(projectName);
    const history = await withPilotDeckGatewayReadRetry(gateway => gateway.readSessionMessages({
        sessionKey: sessionId, projectKey, direction: 'backward', limit: 1,
    }));
    // A live request may have published a newer budget while history was read.
    const latest = getSessionTokenBudget(sessionId);
    return latest.unknown ? history.tokenUsage ?? latest : latest;
}
