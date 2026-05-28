export async function runServerStartupBeforeListen({
  initializeDatabaseFn,
  ensureLocalUserWhenAuthDisabledFn,
  configureWebPushFn
}) {
  if (typeof initializeDatabaseFn !== 'function') {
    throw new TypeError('initializeDatabaseFn is required');
  }
  if (typeof ensureLocalUserWhenAuthDisabledFn !== 'function') {
    throw new TypeError('ensureLocalUserWhenAuthDisabledFn is required');
  }
  if (typeof configureWebPushFn !== 'function') {
    throw new TypeError('configureWebPushFn is required');
  }

  await initializeDatabaseFn();
  await ensureLocalUserWhenAuthDisabledFn();
  configureWebPushFn();
}

export async function startServerAfterStartup({
  startupFn,
  listenFn
}) {
  if (typeof startupFn !== 'function') {
    throw new TypeError('startupFn is required');
  }
  if (typeof listenFn !== 'function') {
    throw new TypeError('listenFn is required');
  }

  await startupFn();
  return await listenFn();
}
