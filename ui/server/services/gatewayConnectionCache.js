/**
 * Keep one shared Gateway connection while allowing a closed instance to be
 * replaced. The expected-instance guard prevents a late close event from an
 * older socket from invalidating a newer connection.
 */
export function createGatewayConnectionCache({
  connect,
  onConnected = () => {},
  onDisconnected = () => {},
}) {
  let pending = null;
  let current = null;

  const invalidate = (expectedGateway) => {
    if (expectedGateway && current !== expectedGateway) return false;
    pending = null;
    current = null;
    return true;
  };

  const get = () => {
    if (pending) return pending;

    const attempt = Promise.resolve()
      .then(() => connect())
      .then((gateway) => {
        if (pending !== attempt) return gateway;
        current = gateway;
        onConnected(gateway);
        gateway.onDisconnect?.((error) => {
          if (!invalidate(gateway)) return;
          onDisconnected(error, gateway);
        });
        return gateway;
      })
      .catch((error) => {
        if (pending === attempt) invalidate();
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
