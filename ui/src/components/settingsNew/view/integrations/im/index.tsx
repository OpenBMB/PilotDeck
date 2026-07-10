import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import FeishuChannelSection from "./components/FeishuChannelSection";
import WeComChannelSection from "./components/WeComChannelSection";
import WeixinChannelSection from "./components/WeixinChannelSection";
import { useGatewayStatus } from "./hooks/useGatewayStatus";
import { PageSectionHeader } from "../../../shared/view";

export default function ImChannelsSection() {
  const { t } = useTranslation("settings");
  const { status, loading, refresh } = useGatewayStatus();

  if (loading || !status) {
    return (
      <div className="space-y-2">
        <PageSectionHeader
          title={t("gateway.title")}
          description={t("gateway.description")}
        />
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageSectionHeader
        title={t("gateway.title")}
        description={t("gateway.description")}
      />
      <FeishuChannelSection status={status.feishu} onSaved={refresh} />
      <WeixinChannelSection status={status.weixin} onSaved={refresh} />
      <WeComChannelSection status={status.wecom} onSaved={refresh} />
    </div>
  );
}
