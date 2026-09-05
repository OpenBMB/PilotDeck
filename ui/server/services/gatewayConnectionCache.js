/**
 * Keep one shared Gateway connection while allowing a closed instance to be
 * replaced. The expected-instance guard prevents a late close event from an
 * older socket from invalidating a newer connection.
 */
export function createGatewayConnectionCache({
  connect,
  onConnected = () => {},
  onDisconnected = () => {},
  shouldReconnect = () => false,
  reconnectBaseDelayMs = 1000,
  reconnectMaxDelayMs = 30000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let pending = null;
  let current = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  const clearScheduledReconnect = () => {
    if (reconnectTimer === null) return;
    clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
  };

  const invalidate = (expectedGateway) => {
    if (expectedGateway && current !== expectedGateway) return false;
    pending = null;
    current = null;
    return true;
  };

  const scheduleReconnect = () => {
    if (pending || current || reconnectTimer !== null || !shouldReconnect()) return;
    const delay = Math.min(
      reconnectMaxDelayMs,
      reconnectBaseDelayMs * (2 ** reconnectAttempt),
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      void get().catch(() => {
        // `get` schedules the next bounded retry while subscribers still exist.
      });
    }, delay);
    reconnectTimer?.unref?.();
  };

  const get = () => {
    if (pending) return pending;
    clearScheduledReconnect();

    const attempt = Promise.resolve()
      .then(() => connect())
      .then((gateway) => {
        if (pending !== attempt) return gateway;
        current = gateway;
        reconnectAttempt = 0;
        onConnected(gateway);
        gateway.onDisconnect?.((error) => {
          if (!invalidate(gateway)) return;
          onDisconnected(error, gateway);
          scheduleReconnect();
        });
        return gateway;
      })
      .catch((error) => {
        if (pending === attempt) {
          invalidate();
          scheduleReconnect();
        }
        throw error;
      });

    pending = attempt;
    return attempt;
  };

  return {
    get,
    invalidate,
    current: () => current,
  };
}
