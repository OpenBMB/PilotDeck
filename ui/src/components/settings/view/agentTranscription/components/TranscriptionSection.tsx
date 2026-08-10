import { useTranslation } from "react-i18next";
import { FormRow, NumberInput, TextInput } from "../../../shared/components/Inputs";
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from "../../../shared/view";
import type { PilotDeckConfig } from "../../modelPool/types";
import { patch } from "../../modelPool/utils/patch";

type TranscriptionSectionProps = {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
};

type TransSpeechConfig = NonNullable<NonNullable<PilotDeckConfig["tools"]>["transSpeech"]>;

type EnabledTransSpeechConfig = {
  enabled: true;
  baseUrl: string;
  language: string;
  asrProfile: string;
  diarize: boolean;
  timeoutMs: number;
  maxConcurrentTasks: number;
  generate: {
    polish: boolean;
    minutes: boolean;
    actions: boolean;
  };
};

const DEFAULT_TRANS_SPEECH_CONFIG: EnabledTransSpeechConfig = {
  enabled: true,
  baseUrl: "http://trans-speech:8090",
  language: "zh",
  asrProfile: "sensevoice",
  diarize: true,
  timeoutMs: 330000,
  maxConcurrentTasks: 1,
  generate: {
    polish: true,
    minutes: true,
    actions: false,
  },
};

function enabledConfig(current: TransSpeechConfig | undefined): EnabledTransSpeechConfig {
  return {
    ...DEFAULT_TRANS_SPEECH_CONFIG,
    ...current,
    enabled: true,
    generate: {
      ...DEFAULT_TRANS_SPEECH_CONFIG.generate,
      ...current?.generate,
    },
  };
}

export default function TranscriptionSection({ config, onChange }: TranscriptionSectionProps) {
  const { t } = useTranslation("settings");
  const current = config.tools?.transSpeech;
  const enabled = current?.enabled === true;
  const transSpeech = enabledConfig(current);

  const setEnabled = (value: boolean) => {
    onChange(patch(
      config,
      ["tools", "transSpeech"],
      value ? enabledConfig(current) : { ...current, enabled: false },
    ));
  };

  const setText = (field: "baseUrl" | "language" | "asrProfile", value: string) => {
    onChange(patch(config, ["tools", "transSpeech", field], value));
  };

  const setNumber = (field: "timeoutMs" | "maxConcurrentTasks", value: number | undefined) => {
    onChange(patch(config, ["tools", "transSpeech", field], value));
  };

  const setGenerate = (field: keyof EnabledTransSpeechConfig["generate"], value: boolean) => {
    onChange(patch(config, ["tools", "transSpeech", "generate", field], value));
  };

  const setMinutes = (value: boolean) => {
    onChange(patch(config, ["tools", "transSpeech", "generate"], {
      ...transSpeech.generate,
      minutes: value,
      actions: value ? transSpeech.generate.actions : false,
    }));
  };

  return (
    <SettingsSection>
      <p className="text-sm text-muted-foreground">{t("pilotDeckConfig.panels.transSpeech.description")}</p>
      <SettingsCard divided>
        <SettingsRow
          label={t("pilotDeckConfig.panels.transSpeech.enabled.label")}
          description={t("pilotDeckConfig.panels.transSpeech.enabled.description")}
        >
          <SettingsToggle
            checked={enabled}
            ariaLabel={t("pilotDeckConfig.panels.transSpeech.enabled.label")}
            onChange={setEnabled}
          />
        </SettingsRow>
        {enabled && (
          <>
            <FormRow
              label={t("pilotDeckConfig.panels.transSpeech.baseUrl.label")}
              description={t("pilotDeckConfig.panels.transSpeech.baseUrl.description")}
            >
              <TextInput value={transSpeech.baseUrl} placeholder="http://trans-speech:8090" monospace onChange={(value) => setText("baseUrl", value)} />
            </FormRow>
            <FormRow
              label={t("pilotDeckConfig.panels.transSpeech.language.label")}
              description={t("pilotDeckConfig.panels.transSpeech.language.description")}
            >
              <TextInput value={transSpeech.language} placeholder="zh" onChange={(value) => setText("language", value)} />
            </FormRow>
            <FormRow
              label={t("pilotDeckConfig.panels.transSpeech.asrProfile.label")}
              description={t("pilotDeckConfig.panels.transSpeech.asrProfile.description")}
            >
              <TextInput value={transSpeech.asrProfile} placeholder="sensevoice" onChange={(value) => setText("asrProfile", value)} />
            </FormRow>
            <SettingsRow
              label={t("pilotDeckConfig.panels.transSpeech.diarize.label")}
              description={t("pilotDeckConfig.panels.transSpeech.diarize.description")}
            >
              <SettingsToggle
                checked={transSpeech.diarize}
                ariaLabel={t("pilotDeckConfig.panels.transSpeech.diarize.label")}
                onChange={(value) => onChange(patch(config, ["tools", "transSpeech", "diarize"], value))}
              />
            </SettingsRow>
            <FormRow
              label={t("pilotDeckConfig.panels.transSpeech.timeoutMs.label")}
              description={t("pilotDeckConfig.panels.transSpeech.timeoutMs.description")}
            >
              <NumberInput value={transSpeech.timeoutMs} placeholder="330000" onChange={(value) => setNumber("timeoutMs", value)} />
            </FormRow>
            <FormRow
              label={t("pilotDeckConfig.panels.transSpeech.maxConcurrentTasks.label")}
              description={t("pilotDeckConfig.panels.transSpeech.maxConcurrentTasks.description")}
            >
              <NumberInput value={transSpeech.maxConcurrentTasks} placeholder="1" onChange={(value) => setNumber("maxConcurrentTasks", value)} />
            </FormRow>
            <SettingsRow
              label={t("pilotDeckConfig.panels.transSpeech.generate.polish.label")}
              description={t("pilotDeckConfig.panels.transSpeech.generate.polish.description")}
            >
              <SettingsToggle checked={transSpeech.generate.polish} ariaLabel={t("pilotDeckConfig.panels.transSpeech.generate.polish.label")} onChange={(value) => setGenerate("polish", value)} />
            </SettingsRow>
            <SettingsRow
              label={t("pilotDeckConfig.panels.transSpeech.generate.minutes.label")}
              description={t("pilotDeckConfig.panels.transSpeech.generate.minutes.description")}
            >
              <SettingsToggle checked={transSpeech.generate.minutes} ariaLabel={t("pilotDeckConfig.panels.transSpeech.generate.minutes.label")} onChange={setMinutes} />
            </SettingsRow>
            <SettingsRow
              label={t("pilotDeckConfig.panels.transSpeech.generate.actions.label")}
              description={t("pilotDeckConfig.panels.transSpeech.generate.actions.description")}
            >
              <SettingsToggle
                checked={transSpeech.generate.actions}
                ariaLabel={t("pilotDeckConfig.panels.transSpeech.generate.actions.label")}
                disabled={!transSpeech.generate.minutes}
                onChange={(value) => setGenerate("actions", value)}
              />
            </SettingsRow>
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
