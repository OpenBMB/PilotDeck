import { useState, useCallback, useRef, useEffect } from 'react';
import { GitCommit, RefreshCw, X, Check, AlertCircle } from 'lucide-react';
import { useGitVersion } from '../../hooks/useGitVersion';
import { cn } from '../../lib/utils.js';
import { restartAndReload, type RestartUiStatus } from '../../utils/restartUi';

type UpdatePhase = 'idle' | 'updating' | 'success' | 'error';
type RestartModalStatus = Exclude<RestartUiStatus, 'confirmed'>;

const RESTART_COPY = {
  restartingTitle: 'Restarting PilotDeck',
  restartingDescription: 'Restart may take a little while. Please wait.',
  failedTitle: 'Automatic restart ran into a problem',
  failedDescription: 'Restart PilotDeck manually from the command line, then refresh this page.',
  refreshPage: 'Refresh',
};

export function VersionBadge() {
  const { info, loading, triggerUpdate, triggerRestart, fetchVersion } = useGitVersion();
  const [showDialog, setShowDialog] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [restartStatus, setRestartStatus] = useState<RestartModalStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  useEffect(() => {
    if (!showDialog) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'updating') setShowDialog(false);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [showDialog, phase]);

  const handleUpdate = useCallback(async () => {
    setPhase('updating');
    setLogs([]);
    const result = await triggerUpdate();
    if (result.success) {
      setLogs(result.lines);
      setPhase('success');
    } else {
      setLogs(result.lines.length > 0 ? result.lines : ['Update failed']);
      setPhase('error');
    }
  }, [triggerUpdate]);

  const handleRestart = useCallback(() => {
    setShowDialog(false);
    restartAndReload(
      (context) => triggerRestart({ signal: context?.signal }),
      {
        copy: {
          title: RESTART_COPY.restartingTitle,
          documentTitle: RESTART_COPY.restartingTitle,
        },
        onStatusChange: (status) => {
          if (status === 'confirmed') return;
          setRestartStatus(status);
        },
      },
    );
  }, [triggerRestart]);

  const handleClose = useCallback(() => {
    if (phase === 'updating') return;
    setShowDialog(false);
    setPhase('idle');
    setLogs([]);
    fetchVersion();
  }, [phase, fetchVersion]);

  if (!info) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setShowDialog(true)}
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors',
          info.hasUpdate
            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60'
            : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700',
        )}
        title={info.hasUpdate ? `Update available (${info.behindCount} commits behind)` : `Version: ${info.commitSha}`}
      >
        <GitCommit className="h-3 w-3" strokeWidth={2} />
        <span>{info.commitSha}</span>
        {info.hasUpdate && (
          <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-blue-400" />
        )}
      </button>

      {restartStatus && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
            {restartStatus === 'restarting' ? (
              <>
                <RefreshCw className="mx-auto mb-4 h-8 w-8 animate-spin text-blue-500" />
                <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {RESTART_COPY.restartingTitle}
                </h2>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {RESTART_COPY.restartingDescription}
                </p>
              </>
            ) : (
              <>
                <AlertCircle className="mx-auto mb-4 h-8 w-8 text-red-500" />
                <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {RESTART_COPY.failedTitle}
                </h2>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {RESTART_COPY.failedDescription}
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {RESTART_COPY.refreshPage}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div
            ref={dialogRef}
            className="relative mx-4 w-full max-w-md rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
          >
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4 dark:border-neutral-700">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                {info.hasUpdate ? 'Update Available' : 'Version Info'}
              </h2>
              <button
                type="button"
                onClick={handleClose}
                disabled={phase === 'updating'}
                className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                  <GitCommit className="h-5 w-5 text-neutral-600 dark:text-neutral-300" />
                </div>
                <div>
                  <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {info.currentCommit}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    Branch: {info.branch}
                  </div>
                </div>
              </div>

              {info.hasUpdate && phase === 'idle' && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/30">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                    {info.behindCount} new commit{info.behindCount > 1 ? 's' : ''} available
                  </p>
                  {info.newCommits.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {info.newCommits.slice(0, 5).map((commit, i) => (
                        <li
                          key={i}
                          className="truncate text-xs font-mono text-blue-700 dark:text-blue-300"
                        >
                          {commit}
                        </li>
                      ))}
                      {info.newCommits.length > 5 && (
                        <li className="text-xs text-blue-600 dark:text-blue-400">
                          ... and {info.newCommits.length - 5} more
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}

              {phase === 'updating' && (
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-800">
                  <div className="flex items-center gap-2 mb-2">
                    <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
                    <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                      Updating...
                    </span>
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded bg-neutral-900 p-2">
                    {logs.map((line, i) => (
                      <div key={i} className="text-[11px] font-mono text-neutral-300 leading-relaxed">
                        {line}
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                </div>
              )}

              {phase === 'success' && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-sm font-medium text-green-800 dark:text-green-200">
                      Update complete!
                    </span>
                  </div>
                  {logs.length > 0 && (
                    <div className="max-h-32 overflow-y-auto rounded bg-neutral-900 p-2 mt-2">
                      {logs.slice(-5).map((line, i) => (
                        <div key={i} className="text-[11px] font-mono text-neutral-300 leading-relaxed">
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {phase === 'error' && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                    <span className="text-sm font-medium text-red-800 dark:text-red-200">
                      Update failed
                    </span>
                  </div>
                  {logs.length > 0 && (
                    <div className="max-h-32 overflow-y-auto rounded bg-neutral-900 p-2 mt-2">
                      {logs.slice(-5).map((line, i) => (
                        <div key={i} className="text-[11px] font-mono text-red-300 leading-relaxed">
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-700">
              {phase === 'idle' && info.hasUpdate && (
                <button
                  type="button"
                  onClick={handleUpdate}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Update Now
                </button>
              )}
              {phase === 'success' && (
                <button
                  type="button"
                  onClick={handleRestart}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Restart to Apply
                </button>
              )}
              {(phase === 'idle' || phase === 'error') && (
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
