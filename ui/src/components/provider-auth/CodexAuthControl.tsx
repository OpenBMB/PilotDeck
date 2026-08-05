import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../utils/api";
import { Button } from "../../shared/view/ui";

type CodexAuthStatus = {
  authenticated: boolean;
  importAvailable: boolean;
  accountId?: string;
  expiresAt?: number;
};

type PendingDeviceLogin = {
  state: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
};

type CodexAuthControlProps = {
  onStatusChange?: (authenticated: boolean) => void;
};

export default function CodexAuthControl({
  onStatusChange,
}: CodexAuthControlProps) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);
  const [pending, setPending] = useState<PendingDeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  const publishStatus = useCallback((next: CodexAuthStatus) => {
    setStatus(next);
    onStatusChange?.(next.authenticated);
  }, [onStatusChange]);

  const refreshStatus = useCallback(async () => {
    const response = await authenticatedFetch("/api/codex-auth/status");
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || t("pilotDeckConfig.panels.models.codexAuth.statusError"));
    }
    if (mounted.current) {
      publishStatus({
        authenticated: Boolean(data.authenticated),
        importAvailable: Boolean(data.importAvailable),
        accountId: typeof data.accountId === "string" ? data.accountId : undefined,
        expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : undefined,
      });
    }
  }, [publishStatus, t]);

  useEffect(() => {
    mounted.current = true;
    void refreshStatus().catch((loadError) => {
      if (mounted.current) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        onStatusChange?.(false);
      }
    });
    return () => {
      mounted.current = false;
    };
  }, [onStatusChange, refreshStatus]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await authenticatedFetch("/api/codex-auth/device/poll", {
          method: "POST",
          body: JSON.stringify({ state: pending.state }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) {
          throw new Error(data?.error || t("pilotDeckConfig.panels.models.codexAuth.pollError"));
        }
        if (!data.pending) {
          if (!cancelled) {
            setPending(null);
            publishStatus({
              authenticated: true,
              importAvailable: Boolean(data.importAvailable),
              accountId: typeof data.accountId === "string" ? data.accountId : undefined,
              expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : undefined,
            });
          }
          return;
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : String(pollError));
          setPending(null);
        }
        return;
      }
      if (!cancelled) timer = setTimeout(poll, pending.intervalMs);
    };

    timer = setTimeout(poll, pending.intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pending, publishStatus, t]);

  const startLogin = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/codex-auth/device/start", {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || t("pilotDeckConfig.panels.models.codexAuth.startError"));
      }
      setPending(data as PendingDeviceLogin);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setBusy(false);
    }
  };

  const importCredentials = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/codex-auth/import", {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || t("pilotDeckConfig.panels.models.codexAuth.importError"));
      }
      publishStatus({
        authenticated: true,
        importAvailable: Boolean(data.importAvailable),
        accountId: typeof data.accountId === "string" ? data.accountId : undefined,
        expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : undefined,
      });
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await authenticatedFetch("/api/codex-auth", {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || t("pilotDeckConfig.panels.models.codexAuth.logoutError"));
      }
      setPending(null);
      publishStatus({ authenticated: false, importAvailable: status?.importAvailable ?? false });
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : String(logoutError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">
            {t("pilotDeckConfig.panels.models.codexAuth.title")}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {status?.authenticated
              ? t("pilotDeckConfig.panels.models.codexAuth.connected")
              : t("pilotDeckConfig.panels.models.codexAuth.description")}
          </div>
        </div>
        {status?.authenticated ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t("pilotDeckConfig.panels.models.codexAuth.statusConnected")}
            </span>
            <Button variant="outline" size="sm" onClick={() => void logout()} disabled={busy}>
              <LogOut className="h-3.5 w-3.5" />
              {t("pilotDeckConfig.panels.models.codexAuth.signOut")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {status?.importAvailable && (
              <Button variant="outline" size="sm" onClick={() => void importCredentials()} disabled={busy}>
                {t("pilotDeckConfig.panels.models.codexAuth.import")}
              </Button>
            )}
            <Button size="sm" onClick={() => void startLogin()} disabled={busy || Boolean(pending)}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("pilotDeckConfig.panels.models.codexAuth.signIn")}
            </Button>
          </div>
        )}
      </div>

      {pending && (
        <div aria-live="polite" className="mt-3 rounded-md border border-primary/30 bg-background p-3 text-xs">
          <div className="text-muted-foreground">
            {t("pilotDeckConfig.panels.models.codexAuth.enterCode")}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <code className="rounded bg-muted px-2 py-1 font-mono text-base font-semibold tracking-wider text-foreground">
              {pending.userCode}
            </code>
            <a
              href={pending.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t("pilotDeckConfig.panels.models.codexAuth.openSignIn")}
              <ExternalLink className="h-3 w-3" />
            </a>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("pilotDeckConfig.panels.models.codexAuth.waiting")}
            </span>
          </div>
        </div>
      )}

      {status?.accountId && (
        <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
          {t("pilotDeckConfig.panels.models.codexAuth.account")}: {status.accountId}
        </div>
      )}
      <div className="mt-2 text-[10px] text-muted-foreground">
        {t("pilotDeckConfig.panels.models.codexAuth.storage")}
      </div>
      {error && (
        <div role="alert" className="mt-2 text-[11px] text-destructive">{error}</div>
      )}
    </div>
  );
}
