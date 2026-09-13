import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfilesSection from "./components/ProfilesSection";
import SettingsSidebar from "../SettingsSidebar";

const prefix = "pilotDeckConfig.panels.agentSubagents";

function baseConfig() {
  return {
    agent: {
      model: "prov/model-a",
      subagents: { default: "inherit", timeoutMs: 60000 },
    },
    model: {
      providers: {
        prov: {
          protocol: "openai",
          url: "https://api.test/v1",
          apiKey: "********",
          models: { "model-a": {}, "model-b": {} },
        },
      },
    },
  } as any;
}

function renderSection(config = baseConfig(), onSave = vi.fn().mockResolvedValue({ ok: true })) {
  render(<ProfilesSection config={config} saving={false} onSave={onSave} />);
  return { onSave };
}

function listRegion() {
  return within(screen.getByRole("region", { name: `${prefix}.listTitle` }));
}

function previewRegion() {
  return screen.getByRole("region", { name: `${prefix}.preview.title` });
}

function addCustomRole() {
  fireEvent.click(screen.getByRole("button", { name: `${prefix}.addProfile` }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("agent subagents settings", () => {
  it("shows the subagents entry next to agent routing in the sidebar", () => {
    render(<SettingsSidebar selectedKey="general" onSelect={vi.fn()} onClose={vi.fn()} />);
    const route = screen.getByRole("button", { name: "settingsPage.menu.agentRoute" });
    const subagents = screen.getByRole("button", { name: "settingsPage.menu.agentSubagents" });
    expect(subagents).toBeTruthy();
    expect(route.compareDocumentPosition(subagents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists builtin and custom roles with count and badges", () => {
    const config = baseConfig();
    config.agent.subagents.profiles = {
      vision: { description: "Read images and report details.", readOnly: true },
    };
    renderSection(config);
    const list = listRegion();
    expect(list.getAllByRole("listitem")).toHaveLength(5);
    const visionRow = list.getByRole("button", { name: /vision/ });
    expect(visionRow.textContent).toContain(`${prefix}.badgeCustom`);
    expect(visionRow.textContent).toContain(`${prefix}.badgeReadOnly`);
    expect(list.getByRole("button", { name: /explore/ }).textContent).toContain(
      `${prefix}.badgeBuiltin`,
    );
  });

  it("adds a custom role and saves description, model binding and default tools", async () => {
    const { onSave } = renderSection();
    addCustomRole();
    fireEvent.change(
      screen.getByLabelText(`${prefix}.editor.id.label`),
      { target: { value: "vision" } },
    );
    fireEvent.change(
      screen.getByLabelText(`${prefix}.editor.description.label`),
      { target: { value: "Read images and report visual details." } },
    );
    fireEvent.change(
      screen.getByLabelText(`${prefix}.editor.model.label`),
      { target: { value: "prov/model-b" } },
    );
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const saved = onSave.mock.calls[0][0];
    expect(saved.agent.subagents.profiles.vision).toEqual({
      description: "Read images and report visual details.",
      model: "prov/model-b",
      tools: ["read_file", "grep", "glob"],
      readOnly: true,
      enabled: true,
    });
    expect(saved.agent.subagents.default).toBe("inherit");
    expect(saved.agent.subagents.timeoutMs).toBe(60000);
    expect(saved.agent.model).toBe("prov/model-a");
    expect(saved.model.providers.prov.models["model-b"]).toEqual({});
  });

  it("previews the exact injected role list and reflects draft edits before saving", () => {
    const config = baseConfig();
    config.agent.subagents.profiles = {
      vision: { description: "Read images.", tools: ["read_file"], readOnly: true, enabled: false },
    };
    renderSection(config);
    const preview = previewRegion();
    expect(preview.textContent).toContain("- general-purpose:");
    expect(preview.textContent).not.toContain("vision");
    // Enabling the disabled role updates the draft preview before any save.
    fireEvent.click(listRegion().getByRole("button", { name: /vision/ }));
    fireEvent.click(
      screen.getByRole("switch", { name: `${prefix}.editor.enabled.label` }),
    );
    expect(preview.textContent).toContain("- vision: Read images.");
  });

  it("marks a not-yet-valid draft role and keeps the exact preview pending", () => {
    renderSection();
    addCustomRole();
    expect(previewRegion().textContent).toContain(`${prefix}.preview.invalid`);
    expect(
      screen.getByText(`${prefix}.errors.descriptionRequired`).textContent,
    ).toContain(`${prefix}.errors.descriptionRequired`);
  });

  it("disables a builtin with a minimal override that preserves preset fields", async () => {
    const { onSave } = renderSection();
    fireEvent.click(listRegion().getByRole("button", { name: /explore/ }));
    fireEvent.click(
      screen.getByRole("switch", { name: `${prefix}.editor.enabled.label` }),
    );
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].agent.subagents.profiles.explore).toEqual({
      enabled: false,
    });
  });

  it("narrows a read-only builtin preset to its tools plus agent only", async () => {
    const { onSave } = renderSection();
    fireEvent.click(listRegion().getByRole("button", { name: /explore/ }));
    // bash is part of the preset and can be unchecked; write tools cannot be added.
    fireEvent.click(screen.getByLabelText("bash"));
    expect(screen.queryByLabelText("write_file")).toBeNull();
    fireEvent.click(screen.getByLabelText("agent"));
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].agent.subagents.profiles.explore).toEqual({
      tools: ["read_file", "grep", "glob", "agent"],
    });
  });

  it("preserves implicit custom defaults when a displayed tool is unchecked", async () => {
    const config = baseConfig();
    config.agent.subagents.profiles = {
      vision: { description: "Read images." },
    };
    const { onSave } = renderSection(config);
    fireEvent.click(listRegion().getByRole("button", { name: /vision/ }));
    expect((screen.getByLabelText("read_file") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("read_file"));
    expect((screen.getByLabelText("read_file") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("grep") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("glob") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].agent.subagents.profiles.vision.tools).toEqual(["grep", "glob"]);
  });

  it("deletes a custom role after confirmation and keeps unrelated config", async () => {
    const config = baseConfig();
    config.agent.subagents.profiles = {
      vision: { description: "Read images.", readOnly: true },
      other: { description: "Do other things.", readOnly: true },
    };
    const { onSave } = renderSection(config);
    fireEvent.click(listRegion().getByRole("button", { name: /vision/ }));
    fireEvent.click(screen.getAllByRole("button", { name: `${prefix}.editor.delete` })[0]);
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.editor.deleteConfirm` }));
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const saved = onSave.mock.calls[0][0];
    expect(saved.agent.subagents.profiles.vision).toBeUndefined();
    expect(saved.agent.subagents.profiles.other).toEqual({
      description: "Do other things.",
      readOnly: true,
    });
    expect(saved.agent.subagents.default).toBe("inherit");
    expect(saved.agent.model).toBe("prov/model-a");
  });

  it("resets an overridden builtin to its preset while keeping other roles", async () => {
    const config = baseConfig();
    config.agent.subagents.profiles = {
      explore: { model: "prov/model-b" },
      vision: { description: "Read images.", readOnly: true },
    };
    const { onSave } = renderSection(config);
    fireEvent.click(listRegion().getByRole("button", { name: /explore/ }));
    fireEvent.click(
      listRegion().getByRole("button", { name: `${prefix}.editor.resetAria` }),
    );
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const savedProfiles = onSave.mock.calls[0][0].agent.subagents.profiles;
    expect(savedProfiles.explore).toBeUndefined();
    expect(savedProfiles.vision).toEqual({ description: "Read images.", readOnly: true });
  });

  it("blocks saving and reports the error while a custom role is incomplete", () => {
    const { onSave } = renderSection();
    addCustomRole();
    const save = screen.getByRole("button", { name: `${prefix}.save` });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText(`${prefix}.errors.descriptionRequired`),
    ).toBeTruthy();
  });

  it("keeps the draft and shows the failure when saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Unable to save config"));
    renderSection(baseConfig(), onSave);
    addCustomRole();
    fireEvent.change(
      screen.getByLabelText(`${prefix}.editor.description.label`),
      { target: { value: "Read images." } },
    );
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("Unable to save config"),
    ).toBeTruthy();
    // The draft survives the failed save and can be submitted again unchanged.
    expect(
      (screen.getByLabelText(`${prefix}.editor.description.label`) as HTMLTextAreaElement).value,
    ).toBe("Read images.");
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0].agent.subagents.profiles["profile-1"].description).toBe(
      "Read images.",
    );
  });

  it("defaults maxDepth to 1 and saves the selected global depth", async () => {
    const { onSave } = renderSection();
    const depth = screen.getByLabelText(
      `${prefix}.maxDepth.label`,
    ) as HTMLSelectElement;
    expect(depth.value).toBe("1");
    fireEvent.change(depth, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const saved = onSave.mock.calls[0][0];
    expect(saved.agent.subagents.maxDepth).toBe(2);
    expect(saved.agent.subagents.timeoutMs).toBe(60000);
  });

  it("keeps the ID editor usable while clearing or entering an existing ID", async () => {
    const { onSave } = renderSection();
    addCustomRole();
    fireEvent.change(screen.getByLabelText(`${prefix}.editor.description.label`), { target: { value: "Read images." } });
    fireEvent.change(screen.getByLabelText(`${prefix}.editor.id.label`), { target: { value: "" } });
    expect((screen.getByLabelText(`${prefix}.editor.id.label`) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: `${prefix}.save` }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(`${prefix}.editor.id.label`), { target: { value: "explore" } });
    expect(screen.getByText(`${prefix}.errors.idTaken`)).toBeTruthy();
    expect(screen.getByRole("button", { name: `${prefix}.save` }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(`${prefix}.editor.id.label`), { target: { value: "vision" } });
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].agent.subagents.profiles.vision.description).toBe("Read images.");
    expect(onSave.mock.calls[0][0].agent.subagents.profiles.explore).toBeUndefined();
  });

  it("does not permit save by moving away from an invalid draft role", () => {
    renderSection();
    addCustomRole();
    fireEvent.click(listRegion().getByRole("button", { name: /explore/ }));
    expect(screen.getByRole("button", { name: `${prefix}.save` }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an empty injected catalog when delegation is disabled", () => {
    const config = baseConfig();
    config.agent.subagents.maxDepth = 0;
    renderSection(config);
    expect(previewRegion().textContent).not.toContain("- general-purpose:");
  });

  it("lets users switch from all parent tools to an explicit allowlist", async () => {
    const { onSave } = renderSection();
    expect((screen.getByLabelText("read_file") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(`${prefix}.editor.tools.all`));
    fireEvent.click(screen.getByLabelText("read_file"));
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].agent.subagents.profiles["general-purpose"].tools).toEqual(["read_file"]);
  });

  it("becomes clean after the server normalizes a successful save", async () => {
    const initial = baseConfig();
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    const view = render(<ProfilesSection config={initial} saving={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText(`${prefix}.maxDepth.label`), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: `${prefix}.save` }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const normalized = { ...onSave.mock.calls[0][0], memory: { enabled: false } };
    view.rerender(<ProfilesSection config={normalized} saving={false} onSave={onSave} />);
    expect(screen.getByRole("button", { name: `${prefix}.save` }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText(`${prefix}.maxDepth.label`) as HTMLSelectElement).value).toBe("2");
  });
});
