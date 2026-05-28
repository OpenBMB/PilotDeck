import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { readFile } from "node:fs/promises";
import type { Gateway, GatewayMode, GatewaySessionInfo } from "../../../../gateway/index.js";
import { readPermissionSettings, writePermissionSettings } from "../../../../permission/settings.js";
import { defaultTuiSessionKey } from "../TuiChannel.js";
import { ActivityLine } from "./ActivityLine.js";
import { Header } from "./Header.js";
import { HelpDialog } from "./HelpDialog.js";
import { MessageList } from "./MessageList.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { PromptInput } from "./PromptInput.js";
import { SessionSidebar, MIN_SIDEBAR_COLS } from "./SessionSidebar.js";
import { ToolOutputViewer } from "./ToolOutputViewer.js";
import { computeSmartCollapse, groupSessions, flattenSidebarRows } from "./sidebar-helpers.js";
import { applyGatewayEventToTuiState, type TuiAppState, type TuiMessage } from "./types.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export type TuiAppProps = {
  gateway: Gateway;
  connection: "remote" | "in_process";
  projectKey?: string;
  sessionKey?: string;
  model?: string;
  cwd?: string;
  serverUrl?: string;
  /** Called when user requests to view a persisted tool output file. */
  onViewOutput?: (path: string) => Promise<void>;
};

export function TuiApp(props: TuiAppProps): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = Math.max(10, (stdout?.rows ?? 28) - 7);
  const initialSessionKey = props.sessionKey ?? defaultTuiSessionKey(props.projectKey);
  // Tracks when a ctrl combo key was pressed so handleInputChange can
  // discard the raw character that ink-text-input receives alongside it.
  // Uses a timestamp because onChange may fire before or after useInput.
  const suppressUntilRef = useRef(0);

  const [state, setState] = useState<TuiAppState>(() => {
    const perm = readPermissionSettings();
    return {      connection: props.connection,
      activeSessionKey: initialSessionKey,
      sessions: [],
      messages: [],
      activity: [],
      input: "",
      mode: perm.skipPermissions ? "bypassPermissions" : "default",
      isRunning: false,
      helpOpen: false,
      helpTab: "shortcuts",
      settingsCursor: 0,
      scrollOffset: 0,
      focusedIndex: null,
      viewerContent: null,
      viewerTitle: "",
      pendingPermissions: [],
      dashboardMode: "closed",
      sidebarCursorIndex: 0,
      sidebarCollapsed: new Set(),
      sidebarGroupBy: "project",
    };
  });

  useEffect(() => {
    void props.gateway
      .listSessions({ projectKey: props.projectKey, limit: 8 })
      .then((result) => setState((current) => ({ ...current, sessions: result.sessions })))
      .catch(() => undefined);
  }, [props.gateway, props.projectKey]);

  const handleInputChange = useCallback((next: string) => {
    // Defer to next microtick so useInput's suppress always runs first
    queueMicrotask(() => {
      if (Date.now() < suppressUntilRef.current) {
        return;
      }
      setState((current) => ({ ...current, input: next, focusedIndex: null }));
    });
  }, []);

  const openViewer = useCallback((content: string, title: string) => {
    setState((current) => ({ ...current, viewerContent: content, viewerTitle: title }));
  }, []);

  const closeViewer = useCallback(() => {
    setState((current) => ({ ...current, viewerContent: null, viewerTitle: "" }));
  }, []);

  const openSidebar = useCallback(async () => {
    const cols = stdout?.columns ?? 80;
    try {
      const result = await props.gateway.listSessions({ projectKey: props.projectKey, limit: 20 });
      setState((current) => {
        const groups = groupSessions(result.sessions, current.sidebarGroupBy);
        const smartCollapse = computeSmartCollapse(groups, current.activeSessionKey);
        return {
          ...current,
          sessions: result.sessions,
          dashboardMode: cols >= MIN_SIDEBAR_COLS ? "sidebar" : "overlay",
          sidebarCursorIndex: 0,
          sidebarCollapsed: smartCollapse,
        };
      });
    } catch {
      // if fetch fails, use cached sessions
      const groups = groupSessions(state.sessions, state.sidebarGroupBy);
      setState((current) => {
        const smartCollapse = computeSmartCollapse(groups, current.activeSessionKey);
        return {
          ...current,
          dashboardMode: cols >= MIN_SIDEBAR_COLS ? "sidebar" : "overlay",
          sidebarCursorIndex: 0,
          sidebarCollapsed: smartCollapse,
        };
      });
    }
  }, [props.gateway, props.projectKey, stdout, state.sessions]);

  const switchToSession = useCallback(
    async (sessionKey: string, summary?: string) => {
      void props.gateway.resumeSession({ sessionKey });
      setState((c) => ({
        ...c,
        activeSessionKey: sessionKey,
        dashboardMode: "closed",
        messages: [{ role: "system", text: `Loading session: ${summary || sessionKey}…` }],
        scrollOffset: 0,
        focusedIndex: null,
      }));
      try {
        const result = await props.gateway.readSessionMessages({
          sessionKey,
          projectKey: props.projectKey,
          limit: 50,
          direction: "backward",
        });
        const tuiMessages: TuiMessage[] = [];
        for (const msg of result.messages) {
          if (msg.role === "user" && msg.kind === "text" && msg.text) {
            tuiMessages.push({ role: "user", text: msg.text });
          } else if (msg.role === "assistant" && msg.kind === "text" && msg.text) {
            tuiMessages.push({ role: "assistant", text: msg.text });
          } else if (msg.role === "assistant" && msg.kind === "thinking" && msg.text) {
            const last = tuiMessages.at(-1);
            if (last?.role === "assistant") {
              last.thinking = (last.thinking ?? "") + msg.text;
            }
          } else if (msg.role === "tool" && msg.kind === "tool_result") {
            tuiMessages.push({
              role: "tool",
              text: msg.text ?? (msg.ok ? "ok" : "error"),
              ok: msg.ok,
              toolCallId: msg.toolCallId,
              toolName: msg.toolName,
            });
          } else if (msg.role === "error") {
            tuiMessages.push({ role: "error", text: msg.text ?? "error" });
          }
        }
        setState((c) => ({
          ...c,
          messages: tuiMessages.length > 0 ? tuiMessages : [{ role: "system", text: `Session: ${summary || sessionKey}` }],
        }));
      } catch {
        setState((c) => ({
          ...c,
          messages: [{ role: "system", text: `Switched to session: ${summary || sessionKey}` }],
        }));
      }
    },
    [props.gateway, props.projectKey],
  );

  const openToolOutput = useCallback(
    async (msg: Extract<TuiMessage, { role: "tool" }>) => {
      const SCROLLBACK_LINE_THRESHOLD = 50;
      let text = msg.fullText ?? msg.text;
      if (msg.resultPath) {
        try {
          text = await readFile(msg.resultPath, "utf-8");
        } catch {
          // fallback to what we have
        }
      }
      const lineCount = text.split("\n").length;
      if (lineCount < SCROLLBACK_LINE_THRESHOLD && stdout) {
        stdout.write(`\n--- ${msg.toolName ?? "tool"} output ---\n${text}\n---\n`);
      } else {
        openViewer(text, msg.toolName ?? "tool output");
      }
    },
    [stdout, openViewer],
  );

  const handleSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      setState((current) => ({ ...current, input: "" }));

      if (!trimmed) {
        if (!state.isRunning && state.focusedIndex !== null) {
          const focused = state.messages[state.focusedIndex];
          if (focused?.role === "tool") {
            setState((current) => {
              const msgs = [...current.messages];
              const msg = msgs[state.focusedIndex!];
              if (msg?.role === "tool") {
                msgs[state.focusedIndex!] = { ...msg, expanded: !msg.expanded };
              }
              return { ...current, messages: msgs };
            });
            return;
          }
        }
        if (!state.isRunning) {
          const lastTool = [...state.messages].reverse().find(
            (m) => m.role === "tool" && ((m.lineCount ?? 0) > 4 || m.resultPath),
          ) as Extract<TuiMessage, { role: "tool" }> | undefined;
          if (lastTool) {
            void openToolOutput(lastTool);
          }
        }
        return;
      }
      if (state.isRunning || state.pendingPermissions.length > 0) {
        return;
      }
      try {
        if (
          await handleCommand(
            trimmed,
            props.gateway,
            props.projectKey,
            setState,
            exit,
            openViewer,
            openToolOutput,
            state.messages,
            openSidebar,
            switchToSession,
          )
        ) {
          return;
        }
      } catch (error) {
        setState((c) => ({
          ...c,
          messages: [...c.messages, { role: "error", text: `Command failed: ${error instanceof Error ? error.message : String(error)}` }],
        }));
        return;
      }

      setState((current) => ({
        ...current,
        messages: [...current.messages, { role: "user", text: trimmed }],
        isRunning: true,
        scrollOffset: 0,
        focusedIndex: null,
      }));

      try {
        for await (const event of props.gateway.submitTurn({
          sessionKey: state.activeSessionKey,
          channelKey: "tui",
          projectKey: props.projectKey,
          message: trimmed,
          mode: state.mode,
        })) {
          setState((current) => {
            const partial = applyGatewayEventToTuiState(current, event);
            return {
              ...current,
              ...partial,
              scrollOffset: partial.messages !== current.messages ? 0 : current.scrollOffset,
            };
          });
        }
      } catch (error) {
        setState((current) => ({
          ...current,
          isRunning: false,
          messages: [
            ...current.messages,
            { role: "error", text: error instanceof Error ? error.message : String(error) },
          ],
        }));
      }
    },
    [exit, props.gateway, props.projectKey, openToolOutput, openViewer, openSidebar, switchToSession, state.activeSessionKey, state.isRunning, state.messages, state.mode, state.focusedIndex, state.pendingPermissions],
  );

  const scrollPage = Math.max(1, Math.floor(rows / 2));

  useInput((input, key) => {
    if (state.viewerContent !== null) return;

    if (state.pendingPermissions.length > 0) {
      const front = state.pendingPermissions[0]!;
      const { requestId, toolName, payload } = front;
      const dequeue = (c: TuiAppState) => ({ ...c, pendingPermissions: c.pendingPermissions.slice(1) });
      if (input === "y") {
        void props.gateway.permissionDecide({
          sessionKey: state.activeSessionKey,
          requestId,
          decision: "allow",
          remember: false,
        });
        setState(dequeue);
        return;
      }
      if (input === "a") {
        void props.gateway.permissionDecide({
          sessionKey: state.activeSessionKey,
          requestId,
          decision: "allow",
          remember: true,
        });
        const entry = buildPermissionEntry(toolName, payload);
        const current = readPermissionSettings();
        if (!current.allowedTools.includes(entry)) {
          writePermissionSettings({ allowedTools: [...current.allowedTools, entry] });
        }
        setState(dequeue);
        return;
      }
      if (input === "n") {
        void props.gateway.permissionDecide({
          sessionKey: state.activeSessionKey,
          requestId,
          decision: "deny",
          reason: "User denied in TUI",
        });
        setState(dequeue);
        return;
      }
      if (key.escape) {
        void props.gateway.abortTurn({ sessionKey: state.activeSessionKey });
        setState((c) => ({ ...c, pendingPermissions: [] }));
        return;
      }
      return;
    }

    // --- Help panel keyboard block ---
    if (state.helpOpen) {
      const tabOrder: Array<"shortcuts" | "settings" | "about"> = ["shortcuts", "settings", "about"];
      if (key.rightArrow || (key.tab && !key.shift)) {
        if (state.helpTab !== "settings") {
          setState((c) => {
            const idx = tabOrder.indexOf(c.helpTab);
            return { ...c, helpTab: tabOrder[(idx + 1) % tabOrder.length]! };
          });
        }
        return;
      }
      if (key.leftArrow || (key.shift && key.tab)) {
        if (state.helpTab !== "settings") {
          setState((c) => {
            const idx = tabOrder.indexOf(c.helpTab);
            return { ...c, helpTab: tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length]! };
          });
        }
        return;
      }
      if (state.helpTab === "settings") {
        const SETTINGS_COUNT = 3;
        if (key.upArrow) {
          setState((c) => ({ ...c, settingsCursor: Math.max(0, c.settingsCursor - 1) }));
          return;
        }
        if (key.downArrow) {
          setState((c) => ({ ...c, settingsCursor: Math.min(SETTINGS_COUNT - 1, c.settingsCursor + 1) }));
          return;
        }
        if (key.return || input === " ") {
          setState((c) => {
            if (c.settingsCursor === 0) {
              const modes: Array<"default" | "plan" | "bypassPermissions"> = ["default", "plan", "bypassPermissions"];
              const idx = modes.indexOf(c.mode as "default" | "plan" | "bypassPermissions");
              const next = modes[(idx + 1) % modes.length]!;
              if (next === "bypassPermissions") {
                writePermissionSettings({ ...readPermissionSettings(), skipPermissions: true });
              } else {
                writePermissionSettings({ ...readPermissionSettings(), skipPermissions: false });
              }
              return { ...c, mode: next };
            }
            return c;
          });
          return;
        }
      }
      if (input === "1") {
        setState((c) => ({ ...c, helpTab: "shortcuts" }));
        return;
      }
      if (input === "2") {
        setState((c) => ({ ...c, helpTab: "settings", settingsCursor: 0 }));
        return;
      }
      if (input === "3") {
        setState((c) => ({ ...c, helpTab: "about" }));
        return;
      }
      if (key.escape || input === "q") {
        setState((c) => ({ ...c, helpOpen: false }));
        return;
      }
      return;
    }

    // --- Sidebar keyboard block ---
    if (state.dashboardMode === "sidebar") {
      const groups = groupSessions(state.sessions, state.sidebarGroupBy);
      const rows = flattenSidebarRows(groups, state.sidebarCollapsed);

      if (key.escape || (key.ctrl && input === "c")) {
        setState((c) => ({ ...c, dashboardMode: "closed" }));
        return;
      }
      if (key.ctrl && input === "e") {
        suppressUntilRef.current = Date.now() + 100;
        setState((c) => ({ ...c, dashboardMode: "closed" }));
        return;
      }
      if (key.ctrl && input === "s") {
        suppressUntilRef.current = Date.now() + 100;
        setState((c) => {
          const next: "project" | "status" = c.sidebarGroupBy === "project" ? "status" : "project";
          const newGroups = groupSessions(c.sessions, next);
          return {
            ...c,
            sidebarGroupBy: next,
            sidebarCursorIndex: 0,
            sidebarCollapsed: computeSmartCollapse(newGroups, c.activeSessionKey),
          };
        });
        return;
      }
      if (key.upArrow && state.input.length === 0) {
        setState((c) => ({
          ...c,
          sidebarCursorIndex: Math.max(0, c.sidebarCursorIndex - 1),
        }));
        return;
      }
      if (key.downArrow && state.input.length === 0) {
        setState((c) => ({
          ...c,
          sidebarCursorIndex: Math.min(rows.length - 1, c.sidebarCursorIndex + 1),
        }));
        return;
      }
      if (key.return) {
        if (state.input.trim().length > 0) {
          // Input has content — let PromptInput handle submission
        } else {
          const row = rows[state.sidebarCursorIndex];
          if (row?.kind === "header") {
            setState((c) => {
              const next = new Set(c.sidebarCollapsed);
              if (next.has(row.groupKey)) next.delete(row.groupKey);
              else next.add(row.groupKey);
              return { ...c, sidebarCollapsed: next };
            });
          } else if (row?.kind === "session") {
            const sessionKey = row.session.sessionKey ?? row.session.sessionId;
            void switchToSession(sessionKey, row.session.summary);
          }
          return;
        }
      }
      if (key.rightArrow && state.input.length === 0) {
        const row = rows[state.sidebarCursorIndex];
        if (row?.kind === "header" && row.collapsed) {
          setState((c) => {
            const next = new Set(c.sidebarCollapsed);
            next.delete(row.groupKey);
            return { ...c, sidebarCollapsed: next };
          });
        } else if (row?.kind === "session") {
          const sessionKey = row.session.sessionKey ?? row.session.sessionId;
          void switchToSession(sessionKey, row.session.summary);
        }
        return;
      }
      if (key.leftArrow && state.input.length === 0) {
        const row = rows[state.sidebarCursorIndex];
        if (row?.kind === "header" && !row.collapsed) {
          setState((c) => {
            const next = new Set(c.sidebarCollapsed);
            next.add(row.groupKey);
            return { ...c, sidebarCollapsed: next };
          });
        } else if (row?.kind === "session") {
          const headerIdx = rows.findIndex(
            (r) => r.kind === "header" && r.groupKey === row.groupKey,
          );
          if (headerIdx >= 0) {
            setState((c) => ({ ...c, sidebarCursorIndex: headerIdx }));
          }
        }
        return;
      }
      // Non-navigation keys fall through to normal input handling
    }

    if (key.ctrl && input === "c") {
      if (state.isRunning) {
        void props.gateway.abortTurn({ sessionKey: state.activeSessionKey });
      } else {
        exit();
      }
      return;
    }

    // Ctrl+E: open sidebar (or toggle off if already open)
    if (key.ctrl && input === "e") {
      suppressUntilRef.current = Date.now() + 100;
      void openSidebar();
      return;
    }

    // Esc: close/interrupt only, never opens anything
    if (key.escape) {
      if (state.isRunning) {
        void props.gateway.abortTurn({ sessionKey: state.activeSessionKey });
        return;
      }
      if (state.helpOpen) {
        setState((c) => ({ ...c, helpOpen: false }));
        return;
      }
      if (state.scrollOffset > 0 || state.focusedIndex !== null) {
        setState((c) => ({ ...c, scrollOffset: 0, focusedIndex: null }));
        return;
      }
      return;
    }
    if (input === "?" && state.input.length === 0) {
      setState((current) => ({ ...current, helpOpen: !current.helpOpen }));
      return;
    }

    if (key.tab && state.input.length === 0) {
      setState((current) => {
        const toolIndices = current.messages
          .map((m, i) => (m.role === "tool" ? i : -1))
          .filter((i) => i >= 0);
        if (toolIndices.length === 0) return current;

        if (key.shift) {
          if (current.focusedIndex === null) {
            return { ...current, focusedIndex: toolIndices[toolIndices.length - 1]! };
          }
          const pos = toolIndices.indexOf(current.focusedIndex);
          const next = pos <= 0 ? toolIndices[toolIndices.length - 1]! : toolIndices[pos - 1]!;
          return { ...current, focusedIndex: next };
        } else {
          if (current.focusedIndex === null) {
            return { ...current, focusedIndex: toolIndices[0]! };
          }
          const pos = toolIndices.indexOf(current.focusedIndex);
          const next = pos >= toolIndices.length - 1 ? toolIndices[0]! : toolIndices[pos + 1]!;
          return { ...current, focusedIndex: next };
        }
      });
      return;
    }

    if (key.pageUp || (key.shift && key.upArrow)) {
      setState((current) => {
        const maxOffset = Math.max(0, current.messages.length - 1);
        return { ...current, scrollOffset: Math.min(maxOffset, current.scrollOffset + scrollPage) };
      });
      return;
    }

    if (key.pageDown || (key.shift && key.downArrow)) {
      setState((current) => ({
        ...current,
        scrollOffset: Math.max(0, current.scrollOffset - scrollPage),
      }));
      return;
    }
  });

  if (state.viewerContent !== null) {
    return (
      <ToolOutputViewer
        content={state.viewerContent}
        title={state.viewerTitle}
        onClose={closeViewer}
      />
    );
  }

  const showSidebar = state.dashboardMode === "sidebar";
  const sidebarGroups = groupSessions(state.sessions, state.sidebarGroupBy);

  const chatContent = (
    <Box flexDirection="column" flexGrow={1} minHeight={12}>
      <Header state={state} model={props.model} cwd={props.cwd ?? process.cwd()} serverUrl={props.serverUrl} />
      <MessageList
        state={state}
        rows={rows}
        model={props.model}
        cwd={props.cwd ?? process.cwd()}
        serverUrl={props.serverUrl}
      />
      {state.helpOpen ? (
        <HelpDialog
          activeTab={state.helpTab}
          mode={state.mode}
          connection={state.connection === "remote" ? (props.serverUrl ? `remote (${props.serverUrl})` : "remote") : "local"}
          sessionKey={state.activeSessionKey}
          model={props.model}
          settingsCursor={state.settingsCursor}
        />
      ) : null}
      {!state.helpOpen && !showSidebar ? <SessionHint sessions={state.sessions} /> : null}
      {state.pendingPermissions.length > 0 ? (
        <PermissionPrompt
          toolName={state.pendingPermissions[0]!.toolName}
          payload={state.pendingPermissions[0]!.payload}
          queueLength={state.pendingPermissions.length}
        />
      ) : null}
      <ActivityLine state={state} />
      <PromptInput
        value={state.input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isRunning={state.isRunning}
        focus={!state.helpOpen && state.pendingPermissions.length === 0}
      />
    </Box>
  );

  if (showSidebar) {
    return (
      <Box flexDirection="row" minHeight={12}>
        <SessionSidebar
          groups={sidebarGroups}
          collapsed={state.sidebarCollapsed}
          cursorIndex={state.sidebarCursorIndex}
          activeSessionKey={state.activeSessionKey}
          maxRows={rows}
          groupBy={state.sidebarGroupBy}
        />
        {chatContent}
      </Box>
    );
  }

  return chatContent;
}

async function handleCommand(
  command: string,
  gateway: Gateway,
  projectKey: string | undefined,
  setState: React.Dispatch<React.SetStateAction<TuiAppState>>,
  exit: () => void,
  openViewer: (content: string, title: string) => void,
  openToolOutput: (msg: Extract<TuiMessage, { role: "tool" }>) => Promise<void>,
  messages: TuiMessage[],
  openSidebar: () => Promise<void>,
  switchToSession: (sessionKey: string, summary?: string) => Promise<void>,
): Promise<boolean> {
  if (!command.startsWith("/")) {
    return false;
  }
  const [name, ...args] = command.split(/\s+/);
  switch (name) {
    case "/new": {
      const result = await gateway.newSession({ channelKey: "tui", projectKey });
      setState((current) => ({
        ...current,
        activeSessionKey: result.sessionKey,
        messages: [{ role: "system", text: `New session: ${result.sessionKey}` }],
      }));
      return true;
    }
    case "/sessions":
    case "/switch":
    case "/dashboard": {
      if (name === "/switch" && args.length > 0) {
        const n = parseInt(args[0]!, 10);
        if (!isNaN(n) && n >= 1) {
          const result = await gateway.listSessions({ projectKey, limit: 20 });
          const target = result.sessions[n - 1];
          if (target) {
            const sessionKey = target.sessionKey ?? target.sessionId;
            setState((c) => ({ ...c, sessions: result.sessions }));
            void switchToSession(sessionKey, target.summary);
            return true;
          }
        }
      }
      void openSidebar();
      return true;
    }
    case "/permissions": {
      const sub = args[0];
      const current = readPermissionSettings();
      if (!sub) {
        const lines = [
          `skipPermissions: ${current.skipPermissions}`,
          `allow: ${current.allowedTools.length === 0 ? "(none)" : current.allowedTools.join(", ")}`,
          `deny: ${current.disallowedTools.length === 0 ? "(none)" : current.disallowedTools.join(", ")}`,
        ];
        setState((c) => ({ ...c, messages: [...c.messages, { role: "system", text: lines.join("\n") }] }));
        return true;
      }
      const entry = args.slice(1).join(" ").trim();
      if (!entry && sub !== "bypass") {
        setState((c) => ({
          ...c,
          messages: [
            ...c.messages,
            {
              role: "error",
              text: "Usage: /permissions [allow|deny|clear <entry>|bypass]",
            },
          ],
        }));
        return true;
      }
      if (sub === "allow" && entry) {
        writePermissionSettings({ allowedTools: [...current.allowedTools, entry] });
        setState((c) => ({ ...c, messages: [...c.messages, { role: "system", text: `Added allow: ${entry}` }] }));
        return true;
      }
      if (sub === "deny" && entry) {
        writePermissionSettings({ disallowedTools: [...current.disallowedTools, entry] });
        setState((c) => ({ ...c, messages: [...c.messages, { role: "system", text: `Added deny: ${entry}` }] }));
        return true;
      }
      if (sub === "clear" && entry) {
        writePermissionSettings({
          allowedTools: current.allowedTools.filter((e) => e !== entry),
          disallowedTools: current.disallowedTools.filter((e) => e !== entry),
        });
        setState((c) => ({ ...c, messages: [...c.messages, { role: "system", text: `Cleared: ${entry}` }] }));
        return true;
      }
      if (sub === "bypass") {
        writePermissionSettings({ skipPermissions: true });
        setState((c) => ({
          ...c,
          mode: "bypassPermissions",
          messages: [...c.messages, { role: "system", text: "Permissions bypassed globally (skipPermissions=true)." }],
        }));
        return true;
      }
      setState((c) => ({
        ...c,
        messages: [...c.messages, { role: "error", text: `Unknown /permissions subcommand: ${sub}` }],
      }));
      return true;
    }
    case "/mode": {
      const mode = (args[0] ?? "default") as GatewayMode;
      if (mode === "bypassPermissions") {
        writePermissionSettings({ skipPermissions: true });
      } else {
        const perm = readPermissionSettings();
        if (perm.skipPermissions) {
          writePermissionSettings({ skipPermissions: false });
        }
      }
      setState((current) => ({
        ...current,
        mode,
        messages: [...current.messages, { role: "system", text: `Mode: ${mode}` }],
      }));
      return true;
    }
    case "/view": {
      const n = parseInt(args[0] ?? "", 10);
      const tools = messages.filter(
        (m): m is Extract<TuiMessage, { role: "tool" }> =>
          m.role === "tool" && ((m.lineCount ?? 0) > 4 || !!m.resultPath || !!m.fullText),
      );
      if (tools.length === 0) {
        setState((current) => ({
          ...current,
          messages: [...current.messages, { role: "system", text: "No tool output to view." }],
        }));
        return true;
      }
      const target = !isNaN(n) && n >= 1 && n <= tools.length
        ? tools[n - 1]!
        : tools[tools.length - 1]!;
      void openToolOutput(target);
      return true;
    }
    case "/clear":
      setState((current) => ({ ...current, messages: [], focusedIndex: null }));
      return true;
    case "/help":
      setState((current) => ({ ...current, helpOpen: !current.helpOpen }));
      return true;
    case "/exit":
      exit();
      return true;
    default:
      setState((current) => ({
        ...current,
        messages: [...current.messages, { role: "error", text: `Unknown command ${name}` }],
      }));
      return true;
  }
}

function buildPermissionEntry(toolName: string, payload: unknown): string {
  if (toolName !== "bash") return toolName;
  const record = typeof payload === "object" && payload ? (payload as Record<string, unknown>) : {};
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) return "bash";
  const tokens = command.split(/\s+/);
  if (tokens[0] === "git" && tokens[1]) return `bash:${tokens[0]} ${tokens[1]}:*`;
  return `bash:${tokens[0]}:*`;
}

function SessionHint({ sessions }: { sessions: GatewaySessionInfo[] }): React.ReactNode {
  if (sessions.length <= 1) {
    return null;
  }
  const count = sessions.length;
  return (
    <Text color={pilotDeckDarkBlueTheme.subtle} dimColor>
      {count} session{count > 1 ? "s" : ""}  ·  Ctrl+E sidebar  ·  /switch N
    </Text>
  );
}
