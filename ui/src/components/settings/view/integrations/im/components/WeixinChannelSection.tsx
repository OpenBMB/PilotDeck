import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../../../shared/view/ui";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  QrCode,
  WechatIcon,
} from "../icons";
import { authenticatedFetch } from "../../../../../../utils/api";
import { cn } from "../../../../../../lib/utils";
import { showSettingsSuccess } from "../../../../shared/SettingsSuccessToast";
import type { RefreshGatewayStatus } from "../hooks/useGatewayStatus";
import type { GatewayStatus } from "../types";

type WeixinChannelSectionProps = {
  status: GatewayStatus["weixin"];
  onSaved: RefreshGatewayStatus;
};

const WEIXIN_QR_PREPARE_TIMEOUT_MS = 30_000;

function isRuntimeCurrent(
  runtime: GatewayStatus["weixin"]["runtime"],
  requestedAt: string | null,
): boolean {
  if (!requestedAt) return true;
  if (typeof runtime?.updatedAt !== "string") return false;
  const runtimeUpdatedAt = Date.parse(runtime.updatedAt);
  const requestStartedAt = Date.parse(requestedAt);
  return Number.isFinite(runtimeUpdatedAt)
    && Number.isFinite(requestStartedAt)
    && runtimeUpdatedAt >= requestStartedAt;
}

function readRuntimeQr(
  status: GatewayStatus["weixin"] | null | undefined,
  requestedAt: string | null = null,
): string | null {
  if (!status?.enabled || status.runtime?.state !== "waiting_for_login") {
    return null;
  }
  if (!isRuntimeCurrent(status.runtime, requestedAt)) return null;
  return status.runtime.qrUrl ?? null;
}

export default function WeixinChannelSection({
  status,
  onSaved,
}: WeixinChannelSectionProps) {
  const { t } = useTranslation("settings");
  const [phase, setPhase] = useState<"idle" | "loading-qr" | "scanning" | "success" | "error">(
    "idle",
  );
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(
    status.enabled && status.runtime?.state === "waiting_for_login",
  );
  const pollRef = useRef<number | null>(null);
  const prepareTimeoutRef = useRef<number | null>(null);
  const requestedAtRef = useRef<string | null>(null);
  const dismissedRuntimeRef = useRef<string | null>(null);
  const runtimeState = status.enabled ? status.runtime?.state : undefined;
  const runtimeLabel =
    runtimeState === "waiting_for_login"
      ? t("gateway.weixin.waitingForLogin")
      : runtimeState === "starting"
        ? t("gateway.weixin.starting")
        : runtimeState === "expired"
          ? t("gateway.weixin.expired")
          : runtimeState === "failed"
            ? t("gateway.weixin.failed")
            : null;
  const statusText =
    runtimeLabel
    ?? (status.enabled && status.hasCredentials
      ? `${t("gateway.connected")}${status.accountId ? ` · ${status.accountId}` : ""}`
      : t("gateway.notConfigured"));
  const badgeTone =
    runtimeState === "waiting_for_login" || runtimeState === "starting"
      ? "amber"
      : runtimeState === "expired" || runtimeState === "failed"
        ? "red"
        : status.enabled
          ? "green"
          : "muted";

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const clearPrepareTimeout = useCallback(() => {
    if (prepareTimeoutRef.current) {
      clearTimeout(prepareTimeoutRef.current);
      prepareTimeoutRef.current = null;
    }
  }, []);

  const clearLoginTimers = useCallback(() => {
    clearPoll();
    clearPrepareTimeout();
  }, [clearPoll, clearPrepareTimeout]);

  const beginResultPoll = useCallback(() => {
    clearPoll();
    pollRef.current = window.setInterval(async () => {
      try {
        const pollRes = await authenticatedFetch("/api/gateway/weixin/qr-poll");
        const pollData = await pollRes.json();
        if (pollData.pending) {
          if (
            pollData.qrUrl
            && isRuntimeCurrent(pollData.runtime, requestedAtRef.current)
          ) {
            clearPrepareTimeout();
            setQrUrl(pollData.qrUrl);
            setPhase("scanning");
          }
          return;
        }
        if (pollData.ok) {
          clearLoginTimers();
          setPhase("success");
          showSettingsSuccess();
          void onSaved();
          return;
        }
        if (!isRuntimeCurrent(pollData.runtime, requestedAtRef.current)) {
          return;
        }
        clearLoginTimers();
        setPhase("error");
        setError(pollData.error || "Login failed");
      } catch {
        // Ignore transient network errors while polling.
      }
    }, 2000);
  }, [
    clearLoginTimers,
    clearPoll,
    clearPrepareTimeout,
    onSaved,
  ]);

  useEffect(() => {
    return clearLoginTimers;
  }, [clearLoginTimers]);

  useEffect(() => {
    if (phase !== "idle") return;
    const existingQrUrl = readRuntimeQr(status);
    if (!existingQrUrl) return;
    if (dismissedRuntimeRef.current === existingQrUrl) return;
    requestedAtRef.current = null;
    setQrUrl(existingQrUrl);
    setPhase("scanning");
    beginResultPoll();
  }, [beginResultPoll, phase, status]);

  useEffect(() => {
    if (phase !== "loading-qr" && phase !== "scanning") return;

    const requestStartedAt = requestedAtRef.current;
    const nextQrUrl = readRuntimeQr(status, requestStartedAt);
    if (nextQrUrl && nextQrUrl !== qrUrl) {
      clearPrepareTimeout();
      setQrUrl(nextQrUrl);
      setPhase("scanning");
    }

    if (status.hasCredentials || runtimeState === "connected") {
      clearLoginTimers();
      setPhase("success");
      return;
    }

    if (
      (
        runtimeState === "failed"
        || runtimeState === "expired"
        || runtimeState === "stopped"
      )
      && isRuntimeCurrent(status.runtime, requestStartedAt)
    ) {
      clearLoginTimers();
      setError(
        status.runtime?.error
        || status.runtime?.message
        || t("gateway.weixin.noRuntimeQr"),
      );
      setPhase("error");
    }
  }, [
    clearLoginTimers,
    clearPrepareTimeout,
    phase,
    qrUrl,
    runtimeState,
    status,
    t,
  ]);

  const startQRLogin = async () => {
    setPhase("loading-qr");
    setError("");
    setQrUrl(null);
    requestedAtRef.current = null;
    dismissedRuntimeRef.current = null;
    clearLoginTimers();
    try {
      const currentQrUrl = readRuntimeQr(status);
      if (currentQrUrl) {
        setQrUrl(currentQrUrl);
        setPhase("scanning");
        beginResultPoll();
        return;
      }

      const refreshed = await onSaved();
      const refreshedQrUrl = readRuntimeQr(refreshed?.weixin);
      if (refreshedQrUrl) {
        setQrUrl(refreshedQrUrl);
        setPhase("scanning");
        beginResultPoll();
        return;
      }

      const res = await authenticatedFetch("/api/gateway/weixin/qr-begin", {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        setPhase("error");
        setError(data.error || t("gateway.weixin.qrPreparing"));
        return;
      }
      requestedAtRef.current = data.requestedAt || new Date().toISOString();
      beginResultPoll();

      prepareTimeoutRef.current = window.setTimeout(() => {
        clearPoll();
        setError(t("gateway.weixin.qrPreparing"));
        setPhase("error");
      }, WEIXIN_QR_PREPARE_TIMEOUT_MS);
    } catch (err: any) {
      clearLoginTimers();
      setPhase("error");
      setError(err.message);
    }
  };

  const handleDisable = async () => {
    try {
      clearLoginTimers();
      const response = await authenticatedFetch("/api/gateway/weixin/disable", { method: "POST" });
      if (!response.ok) return;
      showSettingsSuccess();
      onSaved();
    } catch {
      // ignore
    }
  };

  return (
    <section className={`integration-channel${expanded ? " expanded" : ""}`}>
      <button
        className="integration-channel-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="integration-platform-icon wechat">
          <WechatIcon size={21} />
        </span>
        <span className="integration-channel-copy">
          <strong>
            {t("gateway.weixin.title")} <em>iLink</em>
          </strong>
          <small>
            {status.enabled ? statusText : t("gateway.weixin.summary")}
          </small>
        </span>
        <span
          className={cn(
            "integration-status",
            badgeTone === "green" && "enabled",
            badgeTone === "amber" && "connected",
          )}
        >
          {status.enabled ? <i /> : null}
          {status.enabled
            ? runtimeLabel ?? t("gateway.enabled")
            : t("gateway.notConfigured")}
        </span>
        <span className="integration-channel-toggle">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {expanded ? (
        <div className="integration-channel-detail">
          {phase === "idle" && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={startQRLogin}>
                <QrCode className="mr-1.5 h-3 w-3" />
                {status.enabled ? t("gateway.weixin.relogin") : t("gateway.weixin.qrLogin")}
              </Button>
              {status.enabled && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-500 hover:text-red-600"
                  onClick={handleDisable}
                >
                  {t("gateway.disable")}
                </Button>
              )}
            </div>
          )}

          {phase === "loading-qr" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("gateway.weixin.loadingQr")}
            </div>
          )}

          {phase === "scanning" && qrUrl && (
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-4 dark:bg-white">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                  alt="WeChat QR Code"
                  className="h-[200px] w-[200px]"
                />
              </div>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("gateway.weixin.scanPrompt")}
              </div>
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    dismissedRuntimeRef.current =
                      status.runtime?.qrUrl
                      ?? qrUrl;
                    clearLoginTimers();
                    setPhase("idle");
                  }}
                >
                  {t("gateway.cancel")}
                </Button>
              </div>
            </div>
          )}

          {phase === "success" && (
            <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              {t("gateway.weixin.loginSuccess")}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-xs"
                onClick={() => setPhase("idle")}
              >
                {t("gateway.dismiss")}
              </Button>
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPhase("idle")}>
                {t("gateway.dismiss")}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
