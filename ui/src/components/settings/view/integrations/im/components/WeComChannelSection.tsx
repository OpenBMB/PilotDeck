import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessageSquare,
  QrCode,
  XCircle,
} from "lucide-react";
import { Button } from "../../../../../../shared/view/ui";
import { authenticatedFetch } from "../../../../../../utils/api";
import { SettingsCard, SettingsSection } from "../../../../shared/view";
import { cn } from "../../../../../../lib/utils";
import type { GatewayStatus, TestResult, WeComAccessPolicy } from "../types";

type WeComSetupMode = "choose" | "qr" | "manual";
type WeComQrPhase = "idle" | "connecting" | "scanning" | "success" | "error";

type WeComChannelSectionProps = {
  status: GatewayStatus["wecom"];
  onSaved: () => void;
};

function normalizeWeComPolicy(
  value: string | undefined,
  fallback: WeComAccessPolicy,
): WeComAccessPolicy {
  return value === "open" || value === "allowlist" || value === "disabled"
    ? value
    : fallback;
}

export default function WeComChannelSection({
  status,
  onSaved,
}: WeComChannelSectionProps) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(!status.enabled);
  const [setupMode, setSetupMode] = useState<WeComSetupMode>("choose");
  const [qrPhase, setQrPhase] = useState<WeComQrPhase>("idle");
  const [qrUrl, setQrUrl] = useState("");
  const [qrError, setQrError] = useState("");
  const [botId, setBotId] = useState("");
  const [secret, setSecret] = useState("");
  const [websocketUrl, setWebsocketUrl] = useState(
    status.websocketUrl || "wss://openws.work.weixin.qq.com",
  );
  const [dmPolicy, setDmPolicy] = useState<WeComAccessPolicy>(
    normalizeWeComPolicy(status.dmPolicy, "open"),
  );
  const [groupPolicy, setGroupPolicy] = useState<WeComAccessPolicy>(
    normalizeWeComPolicy(status.groupPolicy, "disabled"),
  );
  const [allowFrom, setAllowFrom] = useState((status.allowFrom || []).join(", "));
  const [groupAllowFrom, setGroupAllowFrom] = useState(
    (status.groupAllowFrom || []).join(", "),
  );
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<TestResult>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    setWebsocketUrl(status.websocketUrl || "wss://openws.work.weixin.qq.com");
    setDmPolicy(normalizeWeComPolicy(status.dmPolicy, "open"));
    setGroupPolicy(normalizeWeComPolicy(status.groupPolicy, "disabled"));
    setAllowFrom((status.allowFrom || []).join(", "));
    setGroupAllowFrom((status.groupAllowFrom || []).join(", "));
  }, [status]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startQR = async () => {
    setQrPhase("connecting");
    setQrError("");
    setQrUrl("");
    try {
      const res = await authenticatedFetch("/api/gateway/wecom/qr-begin", {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        setQrPhase("error");
        setQrError(data.error || "Failed");
        return;
      }
      setQrUrl(data.qrUrl || data.fallbackUrl);
      setQrPhase("scanning");

      pollRef.current = window.setInterval(async () => {
        try {
          const pollRes = await authenticatedFetch("/api/gateway/wecom/qr-poll");
          const pollData = await pollRes.json();
          if (pollData.pending) return;
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          if (pollData.ok) {
            setQrPhase("success");
            onSaved();
          } else {
            setQrPhase("error");
            setQrError(pollData.error || "Failed");
          }
        } catch {
          // ignore network errors while polling
        }
      }, 3000);
    } catch (err: any) {
      setQrPhase("error");
      setQrError(err.message);
    }
  };

  const cancelQR = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    void authenticatedFetch("/api/gateway/wecom/qr-cancel", { method: "POST" });
    setQrPhase("idle");
    setSetupMode("choose");
  };

  const handleSave = async () => {
    if ((!botId && !status.botId) || (!secret && !status.hasSecret)) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await authenticatedFetch("/api/gateway/wecom/save", {
        method: "POST",
        body: JSON.stringify({
          botId,
          secret,
          websocketUrl,
          dmPolicy,
          groupPolicy,
          allowFrom,
          groupAllowFrom,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveResult({ ok: true, message: data.message || t("gateway.wecom.saveSuccess") });
        onSaved();
        setExpanded(false);
        setSetupMode("choose");
        setBotId("");
        setSecret("");
      } else {
        setSaveResult({ ok: false, error: data.error || "Failed" });
      }
    } catch (err: any) {
      setSaveResult({ ok: false, error: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    try {
      await authenticatedFetch("/api/gateway/wecom/disable", { method: "POST" });
      onSaved();
    } catch {
      // ignore
    }
  };

  const closeExpanded = () => {
    cancelQR();
    setSetupMode("choose");
    setExpanded(false);
  };

  return (
    <SettingsSection title={t("gateway.wecom.title")}>
      <SettingsCard>
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-[13px] font-medium text-foreground">
                  {t("gateway.wecom.label")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {status.enabled && status.hasSecret
                    ? `${t("gateway.connected")}${status.botId ? ` · ${status.botId}` : ""}`
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
              {!expanded && (
                <Button
                  variant={status.enabled ? "ghost" : "outline"}
                  size="sm"
                  onClick={() => setExpanded(true)}
                >
                  {status.enabled ? t("gateway.edit") : t("gateway.setup")}
                </Button>
              )}
            </div>
          </div>

          {expanded && setupMode === "choose" && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">{t("gateway.wecom.chooseMethod")}</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSetupMode("qr")}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 text-center transition-colors hover:border-ring hover:bg-accent/30"
                >
                  <QrCode className="h-6 w-6 text-muted-foreground" />
                  <span className="text-[13px] font-medium text-foreground">
                    {t("gateway.wecom.qrSetup")}
                  </span>
                  <span className="text-[11px] leading-4 text-muted-foreground">
                    {t("gateway.wecom.qrSetupDesc")}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSetupMode("manual")}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 text-center transition-colors hover:border-ring hover:bg-accent/30"
                >
                  <KeyRound className="h-6 w-6 text-muted-foreground" />
                  <span className="text-[13px] font-medium text-foreground">
                    {t("gateway.wecom.manualInput")}
                  </span>
                  <span className="text-[11px] leading-4 text-muted-foreground">
                    {t("gateway.wecom.manualInputDesc")}
                  </span>
                </button>
              </div>
              <div className="flex items-center gap-2">
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
                <Button variant="ghost" size="sm" onClick={closeExpanded}>
                  {t("gateway.cancel")}
                </Button>
              </div>
            </div>
          )}

          {expanded && setupMode === "qr" && (
            <div className="space-y-3 border-t border-border pt-4">
              {qrPhase === "idle" && (
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={startQR}>
                    <QrCode className="mr-1.5 h-3 w-3" />
                    {t("gateway.wecom.startQr")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSetupMode("choose")}
                  >
                    {t("gateway.cancel")}
                  </Button>
                </div>
              )}

              {qrPhase === "connecting" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("gateway.wecom.connecting")}
                </div>
              )}

              {qrPhase === "scanning" && qrUrl && (
                <div className="space-y-3">
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-4 dark:bg-white">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                      alt="WeCom QR Code"
                      className="h-[200px] w-[200px]"
                    />
                  </div>
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("gateway.wecom.scanPrompt")}
                  </div>
                  <div className="flex justify-center">
                    <Button variant="ghost" size="sm" onClick={cancelQR}>
                      {t("gateway.cancel")}
                    </Button>
                  </div>
                </div>
              )}

              {qrPhase === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  {t("gateway.wecom.qrSuccess")}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-xs"
                    onClick={closeExpanded}
                  >
                    {t("gateway.dismiss")}
                  </Button>
                </div>
              )}

              {qrPhase === "error" && (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{qrError}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setQrPhase("idle")}>
                      {t("gateway.wecom.retry")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSetupMode("manual")}
                    >
                      {t("gateway.wecom.manualInput")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {expanded && setupMode === "manual" && (
            <div className="space-y-3 border-t border-border pt-4">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("gateway.wecom.botId")}
                </span>
                <input
                  type="text"
                  value={botId}
                  onChange={(e) => setBotId(e.target.value.trim())}
                  placeholder={status.botId || "bot_xxxxxxxxxxxx"}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("gateway.wecom.secret")}
                </span>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value.trim())}
                  placeholder={status.hasSecret ? "Keep existing secret" : "••••••••"}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("gateway.wecom.websocketUrl")}
                </span>
                <input
                  type="text"
                  value={websocketUrl}
                  onChange={(e) => setWebsocketUrl(e.target.value.trim())}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("gateway.wecom.dmPolicy")}
                  </span>
                  <select
                    value={dmPolicy}
                    onChange={(e) => setDmPolicy(e.target.value as WeComAccessPolicy)}
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  >
                    <option value="open">open</option>
                    <option value="allowlist">allowlist</option>
                    <option value="disabled">disabled</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("gateway.wecom.groupPolicy")}
                  </span>
                  <select
                    value={groupPolicy}
                    onChange={(e) => setGroupPolicy(e.target.value as WeComAccessPolicy)}
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  >
                    <option value="disabled">disabled</option>
                    <option value="allowlist">allowlist</option>
                    <option value="open">open</option>
                  </select>
                </label>
              </div>
              {dmPolicy === "allowlist" && (
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">DM allowlist</span>
                  <input
                    type="text"
                    value={allowFrom}
                    onChange={(e) => setAllowFrom(e.target.value)}
                    placeholder="userid1, userid2"
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                  />
                </label>
              )}
              {groupPolicy === "allowlist" && (
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Group allowlist</span>
                  <input
                    type="text"
                    value={groupAllowFrom}
                    onChange={(e) => setGroupAllowFrom(e.target.value)}
                    placeholder="chatid1, chatid2"
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                  />
                </label>
              )}
              <p className="text-[11px] leading-4 text-muted-foreground">
                {t("gateway.wecom.policyHint")}
              </p>

              {saveResult && (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
                    saveResult.ok
                      ? "bg-green-500/10 text-green-700 dark:text-green-400"
                      : "bg-red-500/10 text-red-700 dark:text-red-400",
                  )}
                >
                  {saveResult.ok ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{saveResult.ok ? saveResult.message : saveResult.error}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={
                    ((!botId && !status.botId) || (!secret && !status.hasSecret)) || saving
                  }
                >
                  {saving ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="mr-1.5 h-3 w-3" />
                  )}
                  {t("gateway.save")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSetupMode("choose")}
                >
                  {t("gateway.cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
