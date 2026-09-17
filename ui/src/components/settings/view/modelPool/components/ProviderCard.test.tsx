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

  it.each(['aaa', 'file:///tmp/model'])('rejects malformed or unsupported provider URL %s before saving', (url) => {
    const onSave = vi.fn();
    render(<ProviderCard providerId="test" initialEditing provider={{ protocol: 'openai', url, apiKey: 'key', models: { model: {} } }} onSave={onSave} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    expect(screen.getByText('pilotDeckConfig.panels.models.providerUrlInvalid')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not expose provider retry settings", () => {
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
      />,
    );

    expect(screen.queryByText("pilotDeckConfig.panels.models.providerAdvancedToggle")).toBeNull();
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
    expect(screen.getByRole("button", { name: "my-custom-model" })).toBeTruthy();
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

  it("shows configured when fields are complete without requiring a test", () => {
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

    expect(screen.getByText("pilotDeckConfig.panels.models.configured")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(false);
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

    expect(screen.getByText("pilotDeckConfig.panels.models.configured")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });


  it('saves a model without testing, preserving its other fields and sibling models', async () => {
    const onSave = vi.fn(async (_id: string, _provider: unknown) => ({ok:true}));
    const provider = { protocol:'openai' as const, url:'https://example.test/v1',apiKey:'key',models:{one:{capabilities:{maxOutputTokens:1024,supportsToolUse:true},multimodal:{input:['text','pdf'],maxPdfPages:5}},two:{capabilities:{maxOutputTokens:2048}}}};
    render(<ProviderCard providerId="HXAPI" provider={provider} onSave={onSave} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button',{name:'pilotDeckConfig.panels.models.testConnection'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens'),{target:{value:'8192'}});
    fireEvent.click(screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.imageInput'}));
    fireEvent.click(screen.getByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.save'}));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toMatchObject({models:{one:{capabilities:{maxOutputTokens:8192,supportsToolUse:true},multimodal:{input:['text','pdf','image'],maxPdfPages:5}},two:provider.models.two}});
    expect(mocks.authenticatedFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('tests only the selected model, restores progress after remount and never saves on completion', async () => {
    let tasks: any[] = [];
    mocks.authenticatedFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') tasks = [{id:'single',providerId:'HXAPI',modelId:'one',status:'testing'}];
      return {ok:true,json:async()=>({tasks})};
    });
    const props = {providerId:'HXAPI',provider:{protocol:'openai' as const,url:'https://example.test/v1',apiKey:'key',models:{one:{},two:{}}},onSave:vi.fn(),onRemove:vi.fn()};
    const first = render(<ProviderCard {...props} />);
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    const button = screen.getByRole('button',{name:'pilotDeckConfig.panels.models.testConnection'}) as HTMLButtonElement;
    await waitFor(()=>expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.testing'});
    expect(JSON.parse(mocks.authenticatedFetch.mock.calls.find(([,o])=>o?.method==='POST')![1].body)).toEqual({providerId:'HXAPI',modelId:'one'});
    first.unmount();
    render(<ProviderCard {...props} />);
    fireEvent.click(screen.getByRole('button',{name:'two'}));
    expect((screen.getByRole('button',{name:'pilotDeckConfig.panels.models.testConnection'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'confirmDialog.cancel'}));
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    await screen.findByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.testing'});
    tasks = [{...tasks[0],status:'success',result:{models:[{modelId:'one',textInput:'supported',imageInput:'supported'}]}}];
    await waitFor(()=>expect((screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.imageInput'}) as HTMLInputElement).checked).toBe(true),{timeout:3000});
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'confirmDialog.cancel'}));
    fireEvent.click(screen.getByRole('button',{name:'one'}));
    expect((screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.imageInput'}) as HTMLInputElement).checked).toBe(false);
  });
});
