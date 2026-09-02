import { useTranslation } from "react-i18next";
import FeishuChannelSection from "./components/FeishuChannelSection";
import WeComChannelSection from "./components/WeComChannelSection";
import WeixinChannelSection from "./components/WeixinChannelSection";
import { useGatewayStatus } from "./hooks/useGatewayStatus";
import { ChannelHeaderIcon, Loader2 } from "./icons";

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
      </div>
    </section>
  );
}
