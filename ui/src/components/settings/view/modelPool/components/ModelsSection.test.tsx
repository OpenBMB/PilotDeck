import { useState } from 'react';
import { flushSync } from 'react-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PilotDeckConfig } from "../types";
import { findCatalogProviderById } from "../../../../../shared/catalogProviders";
import ModelsSection from "./ModelsSection";
import ProviderCard from "./ProviderCard";
import type { ConnectionTestTask } from '../hooks/useConnectionTestTasks';

const mocks = vi.hoisted(() => ({
  fetchProviderModels: vi.fn(),
  authenticatedFetch: vi.fn(),
}));

vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: mocks.authenticatedFetch }));

beforeEach(() => {
  mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [] }) });
});

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
  it.each(['new', 'renamed'])('keeps the %s provider model dialog open through save, testing, cancellation and results', async mode => {
    let tasks: ConnectionTestTask[] = [];
    let nextTask = 0;
    const saved = vi.fn();
    mocks.authenticatedFetch.mockImplementation(async (url: string, options?: { method?: string; body?: string }) => {
      if (url.endsWith('/cancel')) tasks = tasks.map(task => ({ ...task, status: 'cancelled' }));
      else if (options?.method === 'POST') tasks = [{ ...JSON.parse(options.body!), id: `task-${++nextTask}`, status: 'testing' }];
      return { ok: true, json: async () => ({ tasks }) };
    });
    function Workspace() {
      const [config, setConfig] = useState<PilotDeckConfig>({ model: { providers: mode === 'new' ? {} : {
        old: { protocol: 'openai', url: 'https://example.test/v1', apiKey: 'key', models: { one: {} } },
        other: { protocol: 'openai', url: 'https://other.test/v1', apiKey: 'other-key', models: { two: {} } },
      } } });
      return <ModelsSection config={config} onChange={async next => {
        saved(next);
        // Config refresh can render before the asynchronous save callback returns.
        flushSync(() => setConfig(next));
        await Promise.resolve();
        return { ok: true };
      }} />;
    }
    render(<Workspace />);
    if (mode === 'new') {
      fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.addProvider' }));
      fireEvent.click(screen.getByRole('button', { name: /pilotDeckConfig\.panels\.models\.customProvider/ }));
      fireEvent.change(screen.getByDisplayValue('provider1'), { target: { value: 'saved-provider' } });
      fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.baseUrl'), { target: { value: 'https://example.test/v1' } });
      fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.apiKey'), { target: { value: 'key' } });
      fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.addModelId' }));
      const input = screen.getByPlaceholderText('pilotDeckConfig.panels.models.customModelIdPlaceholder');
      fireEvent.change(input, { target: { value: 'one' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
      fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'saved-provider' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens'), { target: { value: '180000' } });
    const testButton = screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.modelSettings.saveAndTest' }) as HTMLButtonElement;
    await waitFor(() => expect(testButton.disabled).toBe(false));
    fireEvent.click(testButton);
    await waitFor(() => expect(tasks[0]?.providerId).toBe('saved-provider'));
    expect(saved).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'pilotDeckConfig.panels.models.modelSettings.testing' })).toBeTruthy();
    expect((screen.getByLabelText('pilotDeckConfig.panels.models.maxContextTokens') as HTMLInputElement).value).toBe('180000');
    fireEvent.click(within(dialog).getByRole('button', { name: 'pilotDeckConfig.panels.models.modelSettings.cancelTest' }));
    await waitFor(() => expect(tasks[0].status).toBe('cancelled'));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'pilotDeckConfig.panels.models.modelSettings.testing' })).toBeNull());
    fireEvent.click(within(dialog).getByRole('button', { name: 'pilotDeckConfig.panels.models.testConnection' }));
    await waitFor(() => expect(tasks[0]?.id).toBe('task-2'));
    tasks = [{ ...tasks[0], status: 'success', result: { models: [{ modelId: 'one', textInput: 'supported', imageInput: 'supported' }] } }];
    await within(dialog).findByText('pilotDeckConfig.panels.models.modelSettings.textRequest', {}, { timeout: 3000 });
    expect(within(dialog).getAllByLabelText('pilotDeckConfig.panels.models.modelSettings.passed')).toHaveLength(2);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(saved).toHaveBeenCalledTimes(1);
    if (mode === 'renamed') {
      fireEvent.click(within(dialog).getByRole('button', { name: 'confirmDialog.cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
      fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.apiKey'), { target: { value: 'unsaved-key' } });
      fireEvent.click(screen.getByRole('button', { name: /^other/ }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
      expect((screen.getByLabelText('pilotDeckConfig.panels.models.apiKey') as HTMLInputElement).value).toBe('other-key');
      expect(screen.getByDisplayValue('other')).toBeTruthy();
      expect(saved).toHaveBeenCalledTimes(1);
    }
  });
  it("displays custom provider names with their exact case and separators", () => {
    const provider = { protocol: "openai" as const, url: "https://example.test/v1", apiKey: "********", models: { model: {} } };
    const config = { model: { providers: { HXAPI: provider, hxapi: provider, my_API: provider } } } as PilotDeckConfig;
    render(<ModelsSection config={config} onChange={vi.fn()} />);
    expect(screen.getAllByText("HXAPI").length).toBeGreaterThan(0);
    expect(screen.getByText("hxapi")).toBeTruthy();
    expect(screen.getByText("my_API")).toBeTruthy();
    expect(screen.queryByText("Hxapi")).toBeNull();
    expect(screen.queryByText("My API")).toBeNull();
  });

  it("renames a provider with save metadata so the server rewrites every reference", async () => {
    const onChange = vi.fn(async () => ({ ok: true as const }));
    const provider = { protocol: "openai" as const, url: "https://example.test/v1", apiKey: "********", models: { model: {} } };
    const config = {
      agent: { model: "old/model" },
      model: { providers: { old: provider } },
    } as PilotDeckConfig;
    render(<ModelsSection config={config} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.edit" }));
    fireEvent.change(screen.getByDisplayValue("old"), { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "actions.saveChanges" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const [next, options] = onChange.mock.calls[0] as unknown as [PilotDeckConfig, { providerRenames: unknown }];
    expect(Object.keys(next.model?.providers ?? {})).toEqual(["renamed"]);
    expect(options).toEqual({ providerRenames: [{ from: "old", to: "renamed" }] });
    // The server owns reference rewriting (including routing statistics).
    expect(next.agent?.model).toBe("old/model");
  });

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
      name: "actions.saveChanges",
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
      name: "pilotDeckConfig.panels.models.fetchApiModels",
    }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", {
      name: "actions.saveChanges",
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
    fireEvent.click(screen.getByRole("button", {
      name: "pilotDeckConfig.panels.models.fetchApiModels",
    }));

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
      name: "actions.saveChanges",
    });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(onSave).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "actions.saveChanges",
    })).toBeNull());
  });
});

const passingTest = {
  status: "passed",
  textInput: "supported",
  imageInput: "supported",
};

describe("model provider connection status", () => {
  it("shows pending only for missing fields", () => {
    const { rerender } = render(
      <ModelsSection
        config={{
          model: {
            providers: {
              openrouter: {
                apiKey: "sk-test",
                models: {},
              },
            },
          },
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(
      "pilotDeckConfig.panels.models.pending",
    )).toBeTruthy();

    rerender(
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

    expect(screen.queryByLabelText(
      "pilotDeckConfig.panels.models.pending",
    )).toBeNull();
  });
});
