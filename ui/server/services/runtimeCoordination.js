import { getModelConfigurationState } from './modelConfigurationState.js';

const CONFIGURATION_MESSAGE = 'pilotdeck:configuration-state';
const GATEWAY_STATE_MESSAGE = 'pilotdeck:gateway-state';
const GATEWAY_RETRY_MESSAGE = 'pilotdeck:retry-gateway';

export function createRuntimeCoordination({
  processLike = process,
  env = process.env,
  readConfigurationState = getModelConfigurationState,
} = {}) {
  const supervised = env.PILOTDECK_RUNTIME_SUPERVISED === '1'
    && typeof processLike.send === 'function';
  let gateway = supervised ? { state: 'stopped' } : { state: 'unmanaged' };

  const onMessage = (message) => {
    if (message?.type !== GATEWAY_STATE_MESSAGE) return;
    if (!['stopped', 'starting', 'ready', 'error'].includes(message.state)) return;
    gateway = {
      state: message.state,
      ...(typeof message.error === 'string' && message.error ? { error: message.error } : {}),
    };
  };
  if (supervised) processLike.on?.('message', onMessage);

  const send = (message) => {
    if (!supervised || processLike.connected === false) return false;
    try {
      processLike.send(message);
      return true;
    } catch {
      return false;
    }
  };

  return {
    getGatewayState() {
      return { ...gateway };
    },
    publishConfigurationState() {
      const configuration = readConfigurationState();
      send({ type: CONFIGURATION_MESSAGE, configuration });
      return configuration;
    },
    requestGatewayRetry() {
      return send({ type: GATEWAY_RETRY_MESSAGE });
    },
    dispose() {
      if (supervised) processLike.off?.('message', onMessage);
    },
  };
}

export const runtimeCoordination = createRuntimeCoordination();
