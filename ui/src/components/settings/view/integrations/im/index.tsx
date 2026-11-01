import { useTranslation } from "react-i18next";
import FeishuChannelSection from "./components/FeishuChannelSection";
import TokenChannelSection from "./components/TokenChannelSection";
import WeComChannelSection from "./components/WeComChannelSection";
import WeixinChannelSection from "./components/WeixinChannelSection";
import { useGatewayStatus } from "./hooks/useGatewayStatus";
import { ChannelHeaderIcon, Loader2, SlackIcon, TelegramIcon } from "./icons";

export default function ImChannelsSection() {
  const { t } = useTranslation("settings");
  const { status, loading, refresh } = useGatewayStatus();

  if (loading || !status) {
    return (
      <section className="integration-section">
        <div className="general-card integration-channels-card">
          <header className="general-card-header integration-channels-header">
            <span className="general-card-header-icon">
              <ChannelHeaderIcon size={18} />
            </span>
            <div>
              <h2>{t("gateway.title")}</h2>
              <p>{t("gateway.description")}</p>
            </div>
          </header>
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="integration-section" aria-labelledby="im-section-title">
      <div className="general-card integration-channels-card">
        <header className="general-card-header integration-channels-header">
          <span className="general-card-header-icon">
            <ChannelHeaderIcon size={18} />
          </span>
          <div>
            <h2 id="im-section-title">{t("gateway.title")}</h2>
            <p>{t("gateway.description")}</p>
          </div>
        </header>
        <FeishuChannelSection status={status.feishu} onSaved={refresh} />
        <WeixinChannelSection status={status.weixin} onSaved={refresh} />
        <WeComChannelSection status={status.wecom} onSaved={refresh} />
        {status.slack ? (
          <TokenChannelSection
            channel="slack"
            icon={<SlackIcon size={20} />}
            enabled={status.slack.enabled}
            accountHint={status.slack.botTokenHint}
            runtime={status.slack.runtime}
            onSaved={refresh}
            fields={[
              {
                name: "botToken",
                label: t("gateway.slack.botToken"),
                placeholder: "xoxb-…",
                hint: t("gateway.slack.botTokenHint"),
                configured: status.slack.hasBotToken,
              },
              {
                name: "appToken",
                label: t("gateway.slack.appToken"),
                placeholder: "xapp-…",
                hint: t("gateway.slack.appTokenHint"),
                configured: status.slack.hasAppToken,
              },
            ]}
          />
        ) : null}
        {status.telegram ? (
          <TokenChannelSection
            channel="telegram"
            icon={<TelegramIcon size={20} />}
            enabled={status.telegram.enabled}
            accountHint={status.telegram.tokenHint}
            runtime={status.telegram.runtime}
            onSaved={refresh}
            fields={[
              {
                name: "token",
                label: t("gateway.telegram.token"),
                placeholder: "123456789:AA…",
                hint: t("gateway.telegram.tokenHint"),
                configured: status.telegram.hasToken,
              },
            ]}
          />
        ) : null}
      </div>
    </section>
  );
}
