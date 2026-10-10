import type { ComputerUseBridge, ComputerUseStatus } from '../../../../../shared/computerUse';
import { authenticatedFetch } from '../../../../utils/api';

async function request(action: string, method = 'GET', body?: unknown): Promise<ComputerUseStatus> {
  const response = await authenticatedFetch(`/api/computer-use/${action}`, {
    method, suppressServerErrorToast: true, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Computer use is unavailable');
  return result;
}

export const computerUseApi: ComputerUseBridge = {
  status: () => request('status'),
  setEnabled: enabled => request('enabled', 'PUT', { enabled }),
  refresh: () => request('refresh', 'POST'),
  requestPermission: permission => request('permissions', 'POST', { permission }),
  revealPermissionApp: () => request('permission-app/reveal', 'POST'),
};
