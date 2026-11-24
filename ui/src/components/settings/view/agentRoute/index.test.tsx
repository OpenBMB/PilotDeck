import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { safeParseYaml } from "../modelPool/utils/configYaml";
import AgentRouteSections from "./index";

const mocks = vi.hoisted(() => ({
  commitRaw: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../../hooks/usePilotDeckConfig", () => ({
  usePilotDeckConfig: () => ({
    raw: "agent:\n  model: custom/model\n  subagents:\n    default: inherit\n    timeoutMs: 30000\n    params:\n      temperature: 0.2\n",
    commitRaw: mocks.commitRaw,
    loading: false,
    error: null,
  }),
}));
vi.mock("../../shared/view/ModelReferenceDetail", () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("propagates a rejected config save back to the timeout editor for retry", async () => {
  mocks.commitRaw.mockResolvedValueOnce({ ok: false, error: "Revision conflict" });
  render(<AgentRouteSections title="Agent Route" />);
  fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.edit" }));
  const field = screen.getByLabelText("pilotDeckConfig.panels.agents.subagents.timeoutLabel") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "10.125" } });
  fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.save" }));
  await screen.findByText("Revision conflict");
  expect(field.value).toBe("10.125");
  expect(field.readOnly).toBe(false);
  expect(safeParseYaml(mocks.commitRaw.mock.calls[0][0])?.agent).toEqual({
    model: "custom/model", subagents: { default: "inherit", timeoutMs: 10125, params: { temperature: 0.2 } },
  });
  fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.cancel" }));
  expect(field.value).toBe("30");
});
