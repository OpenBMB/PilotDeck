import React from "react";
import { Box, Text } from "ink";
import { pilotDeckDarkBlueTheme as t } from "./theme.js";
import type { GatewayMode } from "../../../../gateway/index.js";

export type HelpTab = "shortcuts" | "settings" | "about";

const TABS: { key: HelpTab; label: string }[] = [
  { key: "shortcuts", label: "Shortcuts" },
  { key: "settings", label: "Settings" },
  { key: "about", label: "About" },
];

export type HelpDialogProps = {
  activeTab: HelpTab;
  mode: GatewayMode;
  connection: string;
  sessionKey: string;
  model?: string;
  settingsCursor: number;
};

function Row({ keys, desc }: { keys: string; desc: string }) {
  return (
    <Text>
      <Text color={t.brandAccent}>{keys.padEnd(22)}</Text>
      <Text color={t.text}>{desc}</Text>
    </Text>
  );
}

function Separator() {
  return <Text color={t.border}>{"─".repeat(56)}</Text>;
}

function TabBar({ active }: { active: HelpTab }) {
  return (
    <Box flexDirection="row" gap={1}>
      {TABS.map((tab, i) => {
        const sel = tab.key === active;
        return (
          <Text key={tab.key} bold={sel} color={sel ? t.brandAccent : t.subtle} inverse={sel}>
            {` ${i + 1}:${tab.label} `}
          </Text>
        );
      })}
      <Text color={t.subtle} dimColor>  Tab/←→ switch  q/Esc close</Text>
    </Box>
  );
}

function ShortcutsTab(): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color={t.brand}>Commands</Text>
      <Row keys="/new" desc="Start a new session" />
      <Row keys="/sessions" desc="Open session sidebar" />
      <Row keys="/switch [N]" desc="Switch to session N (or open sidebar)" />
      <Row keys="/mode plan|default" desc="Change conversation mode" />
      <Row keys="/mode bypass" desc="Skip all permission checks" />
      <Row keys="/permissions" desc="View/edit permission rules" />
      <Row keys="/view [N]" desc="View tool output block" />
      <Row keys="/clear" desc="Clear transcript" />
      <Row keys="/exit" desc="Quit PilotDeck" />

      <Separator />

      <Text bold color={t.brand}>Keyboard</Text>
      <Row keys="Enter" desc="Send message" />
      <Row keys="Ctrl+E" desc="Toggle session sidebar" />
      <Row keys="Esc" desc="Interrupt agent / close panel" />
      <Row keys="Ctrl+C" desc="Abort turn or exit" />
      <Row keys="Tab / Shift+Tab" desc="Focus next/prev tool output" />
      <Row keys="PageUp / Shift+Up" desc="Scroll up" />
      <Row keys="PageDn / Shift+Dn" desc="Scroll down" />

      <Separator />

      <Text bold color={t.brand}>Sidebar</Text>
      <Row keys="↑↓" desc="Navigate (when input empty)" />
      <Row keys="Enter" desc="Select session / toggle group" />
      <Row keys="←→" desc="Collapse / expand group" />
      <Row keys="Ctrl+S" desc="Switch group: project / status" />
      <Row keys="Esc" desc="Close sidebar" />

      <Separator />

      <Text bold color={t.brand}>Output Viewer</Text>
      <Row keys="j / k" desc="Scroll line" />
      <Row keys="PgUp / PgDn" desc="Scroll page" />
      <Row keys="g / G" desc="Top / bottom" />
      <Row keys="q / Esc" desc="Close" />
    </Box>
  );
}

function SettingsTab({ mode, connection, sessionKey, model, cursor }: {
  mode: GatewayMode;
  connection: string;
  sessionKey: string;
  model?: string;
  cursor: number;
}): React.ReactNode {
  const modeLabel = mode === "bypassPermissions" ? "bypass" : mode;
  const modes = ["default", "plan", "bypass"];
  const modeIdx = modes.indexOf(modeLabel);

  const settings = [
    {
      label: "Mode",
      value: modeLabel,
      hint: `← ${modes[(modeIdx - 1 + modes.length) % modes.length]} | ${modes[(modeIdx + 1) % modes.length]} →`,
      editable: true,
    },
    {
      label: "Connection",
      value: connection,
      hint: "",
      editable: false,
    },
    {
      label: "Model",
      value: model ?? "(default)",
      hint: "",
      editable: false,
    },
  ];

  return (
    <Box flexDirection="column">
      <Text bold color={t.brand}>Settings</Text>
      <Text color={t.subtle} dimColor>↑↓ navigate  Enter toggle  1-3 switch tab</Text>
      <Text> </Text>
      {settings.map((s, i) => {
        const sel = i === cursor;
        const pointer = sel ? "▸" : " ";
        return (
          <Box key={s.label} flexDirection="row">
            <Text color={sel ? t.brandAccent : t.text} bold={sel} inverse={sel}>
              {` ${pointer} ${s.label.padEnd(14)}`}
            </Text>
            <Text color={s.editable ? t.brandAccent : t.subtle} bold={s.editable && sel}>
              {` ${s.value} `}
            </Text>
            {s.editable && sel && s.hint ? (
              <Text color={t.subtle} dimColor>{s.hint}</Text>
            ) : null}
          </Box>
        );
      })}
      <Text> </Text>
      <Separator />
      <Text> </Text>
      <Row keys="Session" desc={sessionKey} />
      <Text> </Text>
      <Text color={t.subtle} dimColor>
        Editable settings marked with ▸ — press Enter to cycle values.
      </Text>
    </Box>
  );
}

function AboutTab(): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold color={t.brand}>PilotDeck</Text>
      <Text> </Text>
      <Text color={t.text}>AI agent runtime with multi-session terminal interface.</Text>
      <Text> </Text>
      <Text color={t.text}>Built with Ink (React for CLI).</Text>
      <Text color={t.text}>Gateway provides session management, tool execution,</Text>
      <Text color={t.text}>and model orchestration.</Text>
      <Text> </Text>
      <Separator />
      <Text> </Text>
      <Text color={t.subtle}>Tip: y/a/n to respond to permission prompts</Text>
      <Text color={t.subtle}>Tip: Enter sends when input has text</Text>
      <Text color={t.subtle}>Tip: ? toggles this help panel</Text>
    </Box>
  );
}

export function HelpDialog({
  activeTab,
  mode,
  connection,
  sessionKey,
  model,
  settingsCursor,
}: HelpDialogProps): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      paddingX={2}
      paddingY={1}
    >
      <TabBar active={activeTab} />
      <Text> </Text>

      {activeTab === "shortcuts" && <ShortcutsTab />}
      {activeTab === "settings" && (
        <SettingsTab mode={mode} connection={connection} sessionKey={sessionKey} model={model} cursor={settingsCursor} />
      )}
      {activeTab === "about" && <AboutTab />}
    </Box>
  );
}
