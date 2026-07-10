import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import GatewayConfigSection from "./components/GatewayConfigSection";
import ImChannelsSection from "./im";

type IntegrationsSectionsProps = {
  title: string;
};

export default function IntegrationsSections({ title }: IntegrationsSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise integrations config patch", caught);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      {loading ? (
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      ) : parsedConfig ? (
        <GatewayConfigSection config={parsedConfig} onChange={onFormChange} />
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          配置文件当前不是有效 YAML，暂时无法加载网关配置表单。
        </div>
      )}
      <ImChannelsSection />
    </div>
  );
}
