import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogProvider } from "../../../../../shared/catalogProviders";
import ProviderCard from "./ProviderCard";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  fetchProviderModels: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../../../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("../../../../../shared/modelListApi", () => ({
  fetchProviderModels: mocks.fetchProviderModels,
}));

const catalogEntry: CatalogProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  protocol: "openai",
  defaultUrl: "https://openrouter.ai/api/v1",
  models: [],
};

describe("ProviderCard custom model add", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mocks.fetchProviderModels.mockResolvedValue([
      { id: "anthropic/claude-fable", displayName: "Claude Fable" },
      { id: "google/gemini-flash", displayName: "Gemini Flash" },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("puts add-model first in candidates and enables a typed ID on enter", async () => {
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "already-on": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "pilotDeckConfig.panels.models.addModelId" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.edit" }));

    const addButton = await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.addModelId" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "anthropic/claude-fable" })).toBeTruthy();
    });

    expect(addButton.parentElement?.firstElementChild).toBe(addButton);
    expect(screen.queryByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder")).toBeNull();

    fireEvent.click(addButton);

    const input = screen.getByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder");
    expect(addButton.nextElementSibling).toBe(input);

    fireEvent.change(input, { target: { value: "my-custom-model" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder")).toBeNull();
    expect(screen.getByText("my-custom-model")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "my-custom-model" })).toBeNull();
  });
});

const passingTest = {
  status: "passed" as const,
  textInput: "supported" as const,
  imageInput: "supported" as const,
};

describe("ProviderCard connection badge", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mocks.fetchProviderModels.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows pending until every enabled model has a passing connection test", () => {
    const onPendingChange = vi.fn();
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
      />,
    );

    expect(screen.getByText("pilotDeckConfig.panels.models.pending")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(true);
  });

  it("shows connected when all enabled models passed, including manual image results", () => {
    const onPendingChange = vi.fn();
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: {
            "model-a": { connectionTest: passingTest },
            "model-b": {
              connectionTest: {
                status: "passed",
                textInput: "supported",
                imageInput: "unsupported",
              },
            },
          },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
      />,
    );

    expect(screen.getByText("pilotDeckConfig.panels.models.connected")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });

  it("binds a passing connection test and then marks the provider connected", async () => {
    const onBindConnectionTest = vi.fn().mockResolvedValue({ ok: true });
    const onPendingChange = vi.fn();
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config/test-connections") {
        return {
          ok: true,
          json: async () => ({
            testId: "test_1",
            status: "passed",
            models: [{
              modelId: "model-a",
              textInput: "supported",
              imageInput: "unsupported",
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
        onBindConnectionTest={onBindConnectionTest}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testConnection" }));

    await waitFor(() => expect(onBindConnectionTest).toHaveBeenCalledWith("test_1"));
    expect(screen.getByText("pilotDeckConfig.panels.models.connected")).toBeTruthy();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });
});
