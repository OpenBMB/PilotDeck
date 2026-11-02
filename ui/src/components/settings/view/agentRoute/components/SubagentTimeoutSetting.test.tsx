import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigSaveResult } from "../../../../../hooks/usePilotDeckConfig";
import RouterSection from "./RouterSection";
import SubagentTimeoutSetting from "./SubagentTimeoutSetting";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const prefix = "pilotDeckConfig.panels.agents.subagents";
const actions = "settingsPage.actions";

function setup(timeoutMs?: number) {
  const subagents = {
    default: "inherit", timeoutMs,
    params: { temperature: 0.2 },
    customRole: { model: "custom/model", description: "Existing role" },
  };
  const config = {
    agent: { model: "custom/model", maxContextTokens: 10000, subagents },
    router: { enabled: false },
    model: { providers: { custom: { models: { model: {} } } } },
  };
  const onSave = vi.fn().mockResolvedValue({ ok: true });
  const view = render(<RouterSection config={config} onChange={onSave} />);
  const field = screen.getByLabelText(`${prefix}.timeoutLabel`) as HTMLInputElement;
  fireEvent.click(screen.getByRole("button", { name: `${actions}.edit` }));
  const save = screen.getByRole("button", { name: `${actions}.save` }) as HTMLButtonElement;
  return { field, save, onSave, subagents, config, view };
}

describe("subagent maximum run duration in AgentRoute", () => {
  it("displays milliseconds as seconds and preserves every sibling when saving fractional seconds", async () => {
    const { field, save, onSave, subagents, config } = setup(1250);
    expect(field.value).toBe("1.25");
    expect(field.min).toBe("0.001");
    expect(field.max).toBe("2147483.647");
    expect(field.step).toBe("0.001");
    fireEvent.change(field, { target: { value: "90.125" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toEqual({
      ...config, agent: { ...config.agent, subagents: { ...subagents, timeoutMs: 90125 } },
    });
    expect(subagents.timeoutMs).toBe(1250);
  });

  it("clears only the override to restore the runtime default", async () => {
    const { field, save, onSave, subagents } = setup(60000);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const { timeoutMs: _timeoutMs, ...siblings } = subagents;
    expect(onSave.mock.calls[0][0].agent.subagents).toEqual(siblings);
    expect(Object.prototype.hasOwnProperty.call(onSave.mock.calls[0][0].agent.subagents, "timeoutMs")).toBe(false);
  });

  it("removes empty timeout-only ancestors when resetting", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<SubagentTimeoutSetting config={{ agent: { subagents: { timeoutMs: 1 } } }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: `${actions}.edit` }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: `${actions}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({}));
  });

  it.each(["0", "-5", "0.0001", "2147483.648", "1e20"])("blocks invalid duration %s", (value) => {
    const { field, save, onSave } = setup();
    fireEvent.change(field, { target: { value } });
    expect(save.disabled).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(`${prefix}.timeoutInvalid`);
    fireEvent.click(save);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "1" } });
    expect(save.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([false, true])("does not mistake a browser-rejected number for clearing the override (already blank: %s)", (alreadyBlank) => {
    const { field, save, onSave } = setup(30000);
    if (alreadyBlank) fireEvent.change(field, { target: { value: "" } });
    const validity = vi.spyOn(field, "validity", "get").mockReturnValue({ badInput: true } as ValidityState);
    fireEvent.input(field, { target: { value: "" } });
    expect(save.disabled).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `${actions}.cancel` }));
    expect(field.value).toBe("30");
    expect(field.getAttribute("aria-invalid")).toBe("false");
    validity.mockRestore();
  });

  it.each([["0.001", 1], ["2147483.647", 2147483647], ["1.2345", 1235]])("saves duration %s at millisecond precision", async (seconds, milliseconds) => {
    const { field, save, onSave } = setup();
    fireEvent.change(field, { target: { value: seconds } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].agent.subagents.timeoutMs).toBe(milliseconds);
  });

  it.each(["button", "Escape"])("cancel via %s restores the saved value", (method) => {
    const { field, onSave } = setup(30000);
    fireEvent.change(field, { target: { value: "10" } });
    if (method === "button") fireEvent.click(screen.getByRole("button", { name: `${actions}.cancel` }));
    else fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("30");
    expect(field.readOnly).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `${actions}.edit` }));
    expect(field.value).toBe("30");
  });

  it.each(["result", "exception"])("retains the draft after a failed save (%s), then accepts the server value", async (mode) => {
    const { field, save, onSave, view } = setup(30000);
    if (mode === "result") onSave.mockResolvedValueOnce({ ok: false, error: "Save rejected" });
    else onSave.mockRejectedValueOnce(new Error("Save rejected"));
    fireEvent.change(field, { target: { value: "10.125" } });
    fireEvent.click(save);
    await screen.findByText("Save rejected");
    // Network/5xx failures can leave the controller's raw draft in place.
    view.rerender(<RouterSection config={onSave.mock.calls[0][0]} onChange={onSave} />);
    expect(field.value).toBe("10.125");
    expect(field.readOnly).toBe(false);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    view.rerender(<RouterSection config={onSave.mock.calls[1][0]} onChange={onSave} />);
    await waitFor(() => expect(field.readOnly).toBe(true));
    expect(field.value).toBe("10.125");
    expect(screen.queryByText("Save rejected")).toBeNull();
  });

  it("preserves config updates received while the timeout is being edited", async () => {
    const { field, save, onSave, config, view } = setup(30000);
    fireEvent.change(field, { target: { value: "5" } });
    const newer = structuredClone(config);
    newer.agent.subagents.params.temperature = 0.8;
    newer.agent.maxContextTokens = 20000;
    view.rerender(<RouterSection config={newer} onChange={onSave} />);
    expect(field.value).toBe("5");
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toEqual({
      ...newer, agent: { ...newer.agent, subagents: { ...newer.agent.subagents, timeoutMs: 5000 } },
    });
  });

  it("does not submit duplicate saves or discard a pending save", async () => {
    const { field, save, onSave } = setup(30000);
    let resolve!: (result: ConfigSaveResult) => void;
    onSave.mockReturnValueOnce(new Promise<ConfigSaveResult>((done) => { resolve = done; }));
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(save);
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onSave).toHaveBeenCalledOnce();
    expect(field.disabled).toBe(true);
    expect((screen.getByRole("button", { name: `${actions}.cancel` }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve({ ok: false, error: "Try again" }); });
    expect(field.value).toBe("5");
    expect(field.disabled).toBe(false);
  });

  it.each(["judge", "skip"] as const)("shows the timeout with smart routing using %s policy", async (policy) => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    const config = { router: { enabled: true, tokenSaver: { subagent: { policy } } } };
    render(<RouterSection config={config} onChange={onSave} />);
    const field = screen.getByLabelText(`${prefix}.timeoutLabel`) as HTMLInputElement;
    const container = field.closest(".advanced-strategy-card")!;
    expect(container).toBeTruthy();
    fireEvent.click(container.querySelector("button")!);
    fireEvent.change(field, { target: { value: "60" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...config, agent: { subagents: { timeoutMs: 60000 } } }));
  });
});
