import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PilotDeckConfig } from "../types";
import { findCatalogProviderById } from "../../../../../shared/catalogProviders";
import ModelsSection from "./ModelsSection";
import ProviderCard from "./ProviderCard";

const mocks = vi.hoisted(() => ({
  fetchProviderModels: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../../../shared/modelListApi", () => ({
  fetchProviderModels: mocks.fetchProviderModels,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("model provider drafts", () => {
  it("keeps a new custom provider local until it is explicitly saved", () => {
    const onChange = vi.fn();
    const config = { model: { providers: {} } } as PilotDeckConfig;

    render(<ModelsSection config={config} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", {
      name: "pilotDeckConfig.panels.models.addProvider",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: /pilotDeckConfig\.panels\.models\.customProvider/,
    }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("provider1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", {
      name: "settingsPage.actions.cancel",
    }));

    expect(screen.queryByDisplayValue("provider1")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("validates a new provider before calling the save handler", () => {
    const onSave = vi.fn(async () => ({ ok: true }));

    render(
      <ProviderCard
        providerId="provider1"
        provider={{ protocol: "openai", url: "", apiKey: "", models: {} }}
        initialEditing
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "settingsPage.actions.save",
    }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(
      "pilotDeckConfig.panels.models.providerUrlRequired",
    )).toBeTruthy();
  });

  it("allows a catalog provider to use its environment API key fallback", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));

    render(
      <ProviderCard
        providerId="anthropic"
        provider={{
          protocol: "anthropic",
          url: "https://api.anthropic.com",
          models: { "claude-sonnet-4.6": {} },
        }}
        catalogEntry={findCatalogProviderById("anthropic")}
        initialEditing
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", {
      name: "Fetch API models",
    }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", {
      name: "settingsPage.actions.save",
    }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(
      "pilotDeckConfig.panels.models.providerApiKeyRequired",
    )).toBeNull();
  });

  it("uses the edited catalog provider ID when fetching with an environment key", async () => {
    mocks.fetchProviderModels.mockResolvedValue([]);

    render(
      <ProviderCard
        providerId="openai"
        provider={{ models: { "gpt-4.1": {} } }}
        catalogEntry={findCatalogProviderById("openai")}
        initialEditing
        onSave={vi.fn(async () => ({ ok: true }))}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("openai"), {
      target: { value: "anthropic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch API models" }));

    await waitFor(() => expect(mocks.fetchProviderModels).toHaveBeenCalledWith({
      providerId: "anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
    }));
  });

  it("prevents duplicate saves while the first provider save is pending", async () => {
    let finish!: (result: { ok: boolean }) => void;
    const onSave = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      finish = resolve;
    }));

    render(
      <ProviderCard
        providerId="provider1"
        provider={{
          protocol: "openai",
          url: "https://api.example.test/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        initialEditing
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    const saveButton = screen.getByRole("button", {
      name: "settingsPage.actions.save",
    });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(onSave).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "settingsPage.actions.save",
    })).toBeNull());
  });
});
