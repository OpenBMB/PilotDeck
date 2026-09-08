// A ref'ed deadline plus explicit child-exit handling makes failed bootstrap
// report its cause instead of Node cancelling an unresolved IPC promise.
export function waitForManagedEvent(child, emitter, event, timeoutMs = 90_000) {
  const completion = child[Symbol.for('pilotdeck.processScope')]?.completion;
  if (completion && emitter === child && event === 'managed-exit') return Promise.resolve([completion.code, completion.signal, completion.startupError]);
  return new Promise((resolve, reject) => {
    let diagnostic = '';
    const cleanup = () => {
      clearTimeout(timer); emitter.off(event, received); child.off('error', failed);
      child.off('exit', exited); child.off('managed-exit', managedExit); child.stderr?.off('data', stderr);
    };
    const received = (...args) => { cleanup(); resolve(args); };
    const failed = error => { cleanup(); reject(error); };
    const exited = (code, signal, message) => failed(new Error(message || `Managed command exited before ${event} (code=${code}, signal=${signal}): ${diagnostic.trim()}`));
    const managedExit = (code, signal, message) => { if (event !== 'managed-exit') exited(code, signal, message); };
    const stderr = chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); };
    const timer = setTimeout(() => failed(new Error(`Timed out waiting for ${event}: ${diagnostic.trim()}`)), timeoutMs);
    emitter.once(event, received); child.once('error', failed); child.once('exit', exited);
    child.on('managed-exit', managedExit); child.stderr?.on('data', stderr);
    if (completion) exited(completion.code, completion.signal, completion.startupError);
    else if (child.exitCode !== null || child.signalCode) exited(child.exitCode, child.signalCode);
  });
}
