import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { PageSectionHeader } from "../../shared/view";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import ServiceSection from "./components/ServiceSection";
import CustomEnvSection from "./components/CustomEnvSection";

type AdvancedSectionsProps = {
  title: string;
};

export default function AdvancedSections({ title }: AdvancedSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise advanced config patch", caught);
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
        <>
          <PageSectionHeader
            title={t("pilotDeckConfig.panels.runtime.title", { defaultValue: "服务" })}
            description="配置服务端口、数据路径和网络代理。修改端口或路径后通常需要重启服务。"
          />
          <ServiceSection config={parsedConfig} onChange={onFormChange} />

          <PageSectionHeader
            title={t("pilotDeckConfig.panels.customEnv.title", { defaultValue: "环境变量" })}
            description="注入到每个智能体会话里的自定义环境变量。持久化到配置文件，切换会话不必重新配置。"
          />
          <CustomEnvSection config={parsedConfig} onChange={onFormChange} />
        </>
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          配置文件当前不是有效 YAML，暂时无法加载高级配置表单。
        </div>
      )}
    </div>
  );
}
