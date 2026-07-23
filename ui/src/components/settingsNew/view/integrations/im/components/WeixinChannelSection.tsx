import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, MessageSquare, QrCode } from "lucide-react";
import { Button } from "../../../../../../shared/view/ui";
import { authenticatedFetch } from "../../../../../../utils/api";
import { SettingsCard, SettingsSection } from "../../../../shared/view";
import type { GatewayStatus } from "../types";

type WeixinChannelSectionProps = {
  status: GatewayStatus["weixin"];
  onSaved: () => void;
};

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
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startQRLogin = async () => {
    setPhase("loading-qr");
    setError("");
    setQrUrl(null);
    try {
      const res = await authenticatedFetch("/api/gateway/weixin/qr");
      const data = await res.json();
      if (!data.ok) {
        setPhase("error");
        setError(data.error || "Failed to get QR code");
        return;
      }
      setQrUrl(data.qrUrl);
      setPhase("scanning");

      pollRef.current = window.setInterval(async () => {
        try {
          const pollRes = await authenticatedFetch("/api/gateway/weixin/qr-poll");
          const pollData = await pollRes.json();
          if (pollData.pending) return;
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (pollData.ok) {
            setPhase("success");
            onSaved();
          } else {
            setPhase("error");
            setError(pollData.error || "Login failed");
          }
        } catch {
          // ignore network errors while polling
        }
      }, 2000);
    } catch (err: any) {
      setPhase("error");
      setError(err.message);
    }
  };

  const handleDisable = async () => {
    try {
      await authenticatedFetch("/api/gateway/weixin/disable", { method: "POST" });
      onSaved();
    } catch {
      // ignore
    }
  };

  return (
    <SettingsSection title={t("gateway.weixin.title")}>
      <SettingsCard>
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-[13px] font-medium text-foreground">
                  {t("gateway.weixin.label")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {status.enabled && status.hasCredentials
                    ? `${t("gateway.connected")}${status.accountId ? ` · ${status.accountId}` : ""}`
                    : t("gateway.notConfigured")}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status.enabled && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  {t("gateway.enabled")}
                </span>
              )}
            </div>
          </div>

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
                    if (pollRef.current) {
                      clearInterval(pollRef.current);
                      pollRef.current = null;
                    }
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
      </SettingsCard>
    </SettingsSection>
  );
}
