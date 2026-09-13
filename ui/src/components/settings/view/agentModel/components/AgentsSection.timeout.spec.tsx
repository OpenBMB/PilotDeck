import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentsSection from "./AgentsSection";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

function setup(timeoutMs?: number) {
  const subagents = { default: "inherit", timeoutMs, params: { temperature: 0.2 } };
  const onChange = vi.fn();
  render(<AgentsSection config={{ agent: { subagents } }} onChange={onChange} />);
  const field = screen.getByPlaceholderText("3600") as HTMLInputElement;
  fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.edit" }));
  return { field, onChange, subagents };
}

describe("subagent maximum run duration", () => {
  it("displays an existing millisecond setting as seconds and preserves sibling settings", () => {
    const { field, onChange, subagents } = setup(1250);
    expect(field.value).toBe("1.25");
    fireEvent.change(field, { target: { value: "90.125" } });
    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.save" }));
    expect(onChange.mock.calls[0][0].agent.subagents).toEqual({ ...subagents, timeoutMs: 90125 });
    expect(subagents.timeoutMs).toBe(1250);
  });

  it("clears the override to restore the runtime default without dropping other settings", () => {
    const { field, onChange } = setup(60000);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.save" }));
    expect(onChange.mock.calls[0][0].agent.subagents).toEqual({ default: "inherit", params: { temperature: 0.2 } });
    expect(Object.hasOwn(onChange.mock.calls[0][0].agent.subagents, "timeoutMs")).toBe(false);
  });

  it.each(["0", "-5", "0.0001", "2147483.648", "1e20"])("prevents saving invalid duration %s", (value) => {
    const { field, onChange } = setup();
    fireEvent.change(field, { target: { value } });
    expect((screen.getByRole("button", { name: "settingsPage.actions.save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancel leaves the saved value intact", () => {
    const { field, onChange } = setup(30000);
    fireEvent.change(field, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.cancel" }));
    expect(field.value).toBe("30");
    expect(onChange).not.toHaveBeenCalled();
  });
});
