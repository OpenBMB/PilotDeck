import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V2Provider } from "../types";
import ModelsSection from "./ModelsSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./CatalogPicker", () => ({
  default: ({ onCustom }: { onCustom: () => void }) => (
    <button type="button" onClick={onCustom}>pick-custom-provider</button>
  ),
}));

vi.mock("./ProviderCard", () => ({
  default: ({
    isNew,
    onSave,
    onCancelNew,
  }: {
    isNew?: boolean;
    onSave: (id: string, provider: V2Provider) => Promise<{ ok: boolean; error?: string }>;
    onCancelNew?: () => void;
  }) => (
    <div>
      <span>{isNew ? "new-provider-draft" : "saved-provider"}</span>
      <button
        type="button"
        onClick={() => void onSave("provider1", {
          protocol: "openai",
          url: "https://example.com/v1",
          apiKey: "secret",
          models: { "model-a": {} },
        })}
      >
        save-provider
      </button>
      <button type="button" onClick={onCancelNew}>cancel-provider</button>
    </div>
  ),
}));

describe("ModelsSection provider creation", () => {
  afterEach(() => {
    cleanup();
  });

  it("persists a new provider only after the user saves it", async () => {
    const onChange = vi.fn().mockResolvedValue({ ok: true });
    render(
      <ModelsSection
        config={{ model: { providers: {} } }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "pick-custom-provider" }));

    expect(screen.getByText("new-provider-draft")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toMatchObject({
      model: {
        providers: {
          provider1: {
            url: "https://example.com/v1",
            models: { "model-a": {} },
          },
        },
      },
    });
  });

  it("discards a new provider without persisting when cancelled", () => {
    const onChange = vi.fn();
    render(
      <ModelsSection
        config={{ model: { providers: {} } }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "pick-custom-provider" }));
    fireEvent.click(screen.getByRole("button", { name: "cancel-provider" }));

    expect(screen.queryByText("new-provider-draft")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

const passingTest = {
  status: "passed",
  textInput: "supported",
  imageInput: "supported",
};

describe("ModelsSection connection status", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows a yellow pending dot when enabled models have not passed connection tests", () => {
    render(
      <ModelsSection
        config={{
          model: {
            providers: {
              openrouter: {
                apiKey: "sk-test",
                models: { "model-a": {} },
              },
            },
          },
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("pilotDeckConfig.panels.models.pending")).toBeTruthy();
  });

  it("hides the yellow pending dot when every enabled model passed connection tests", () => {
    render(
      <ModelsSection
        config={{
          model: {
            providers: {
              openrouter: {
                apiKey: "sk-test",
                models: { "model-a": { connectionTest: passingTest } },
              },
            },
          },
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("pilotDeckConfig.panels.models.pending")).toBeNull();
  });
});
