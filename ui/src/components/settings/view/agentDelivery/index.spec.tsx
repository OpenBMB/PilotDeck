import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { DEFAULT_DELIVERY_PROMPT } from "../../../../../../src/agent/sub/delivery/prompt";
import AgentDeliverySections from "./index";
import { DELIVERY_PROMPT_MAX_BYTES } from "./utils/deliveryConfig";

const mocks = vi.hoisted(() => ({ commitRaw: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../../hooks/usePilotDeckConfig", () => ({
  usePilotDeckConfig: () => ({
    raw: mocks.raw,
    commitRaw: mocks.commitRaw,
    loading: false,
    saving: false,
    error: null,
  }),
}));

let mockedRawValue = "";
// The mocked hook reads this at render time so each test can install its own config.
Object.defineProperty(mocks, "raw", {
  get: () => mockedRawValue,
  configurable: true,
});

const BASE_YAML = [
  "gateway:",
  "  enabled: true",
  "agent:",
  "  model: HXAPI/main",
  "  delivery:",
  "    prompt: Custom guidance only",
  "    reviewerModel: HXAPI/reviewer",
  "    maxRepairs: 3",
  "model:",
  "  providers:",
  "    HXAPI:",
  "      protocol: openai",
  "      url: https://example.test/v1",
  "      models:",
  "        main: {}",
  "        reviewer: {}",
].join("\n");

afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function save() {
  fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.save" }));
  await waitFor(() => expect(mocks.commitRaw).toHaveBeenCalledOnce());
  return parse(mocks.commitRaw.mock.calls[0][0] as string);
}

describe("agent delivery settings", () => {
  it("previews the built-in default prompt when no prompt is stored and saves edits without touching other config", async () => {
    mockedRawValue = [
      "gateway:",
      "  enabled: true",
      "agent:",
      "  model: HXAPI/main",
      "model:",
      "  providers:",
      "    HXAPI:",
      "      protocol: openai",
      "      models:",
      "        main: {}",
    ].join("\n");
    mocks.commitRaw.mockResolvedValue({ ok: true });
    render(<AgentDeliverySections title="Delivery" />);

    expect(
      (screen.getByLabelText("settingsPage.delivery.prompt.label") as HTMLTextAreaElement).value,
    ).toBe(DEFAULT_DELIVERY_PROMPT);

    fireEvent.change(
      screen.getByLabelText("settingsPage.delivery.prompt.label"),
      { target: { value: "Ship a short changelog." } },
    );
    const saved = await save();
    expect(saved.agent.delivery.prompt).toBe("Ship a short changelog.");
    expect(saved.agent.delivery.mode).toBeUndefined();
    expect(saved.agent.model).toBe("HXAPI/main");
    expect(saved.gateway).toEqual({ enabled: true });
  });

  it("restore default deletes the stored prompt field but keeps the rest of delivery config", async () => {
    mockedRawValue = BASE_YAML;
    mocks.commitRaw.mockResolvedValue({ ok: true });
    render(<AgentDeliverySections title="Delivery" />);

    fireEvent.click(
      screen.getByRole("button", { name: "settingsPage.delivery.prompt.restore" }),
    );
    const saved = await save();
    expect(saved.agent.delivery).toEqual({
      reviewerModel: "HXAPI/reviewer",
      maxRepairs: 3,
    });
  });

  it("stores a blank prompt explicitly so only the host protocol is sent", async () => {
    mockedRawValue = BASE_YAML;
    mocks.commitRaw.mockResolvedValue({ ok: true });
    render(<AgentDeliverySections title="Delivery" />);

    fireEvent.change(
      screen.getByLabelText("settingsPage.delivery.prompt.label"),
      { target: { value: "" } },
    );
    const saved = await save();
    expect(saved.agent.delivery.prompt).toBe("");
    expect(saved.agent.delivery.reviewerModel).toBe("HXAPI/reviewer");
  });

  it("off mode keeps stored values but disables editing, and switching back to auto drops the mode key", async () => {
    mockedRawValue = [
      "agent:",
      "  delivery:",
      "    mode: off",
      "    prompt: Keep me",
      "    maxTurns: 44",
    ].join("\n");
    mocks.commitRaw.mockResolvedValue({ ok: true });
    render(<AgentDeliverySections title="Delivery" />);

    const prompt = screen.getByLabelText("settingsPage.delivery.prompt.label") as HTMLTextAreaElement;
    const reviewer = screen.getByLabelText("settingsPage.delivery.reviewer.label") as HTMLSelectElement;
    expect(prompt).toHaveProperty("disabled", true);
    expect(reviewer).toHaveProperty("disabled", true);
    expect(prompt.value).toBe("Keep me");

    fireEvent.click(screen.getByRole("switch", { name: "settingsPage.delivery.mode.label" }));
    expect(prompt).toHaveProperty("disabled", false);
    const saved = await save();
    expect(saved.agent.delivery.mode).toBeUndefined();
    expect(saved.agent.delivery.prompt).toBe("Keep me");
    expect(saved.agent.delivery.maxTurns).toBe(44);
  });

  it("toggling reviewer after an unsaved prompt edit keeps the prompt in the same draft", async () => {
    mockedRawValue = [
      "agent:",
      "  model: HXAPI/main",
      "model:",
      "  providers:",
      "    HXAPI:",
      "      protocol: openai",
      "      models:",
      "        main: {}",
      "        reviewer: {}",
    ].join("\n");
    mocks.commitRaw.mockResolvedValue({ ok: true });
    render(<AgentDeliverySections title="Delivery" />);

    fireEvent.change(
      screen.getByLabelText("settingsPage.delivery.prompt.label"),
      { target: { value: "Draft guidance" } },
    );
    fireEvent.change(
      screen.getByLabelText("settingsPage.delivery.reviewer.label"),
      { target: { value: "HXAPI/reviewer" } },
    );
    const saved = await save();
    expect(saved.agent.delivery.prompt).toBe("Draft guidance");
    expect(saved.agent.delivery.reviewerModel).toBe("HXAPI/reviewer");
  });

  it("blocks saving and shows an alert when the prompt exceeds the byte budget", async () => {
    mockedRawValue = "agent:\n  model: HXAPI/main";
    render(<AgentDeliverySections title="Delivery" />);

    fireEvent.change(
      screen.getByLabelText("settingsPage.delivery.prompt.label"),
      { target: { value: "x".repeat(DELIVERY_PROMPT_MAX_BYTES + 1) } },
    );
    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.commitRaw).not.toHaveBeenCalled();
  });

  it("shows a configuration save failure", async () => {
    mockedRawValue = "agent:\n  model: HXAPI/main";
    mocks.commitRaw.mockRejectedValue(new Error("Unable to save config"));
    render(<AgentDeliverySections title="Delivery" />);

    fireEvent.change(
      screen.getByLabelText("settingsPage.delivery.prompt.label"),
      { target: { value: "Any guidance" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.save" }));
    expect(await screen.findByText("Unable to save config")).toBeTruthy();
  });
});
