import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { PilotDeckConfig } from "../../modelPool/types";
import en from "../../../../../i18n/locales/en/settings.json";
import zh from "../../../../../i18n/locales/zh-CN/settings.json";
import { WEB_SEARCH_DOCS } from "../../../../../../../src/pilot/config/webSearchProviders.js";
import ToolsSection from "./ToolsSection";
// The repository currently resolves mixed React 18/19 provider typings.
const Provider = I18nextProvider as any;
const fetch = vi.hoisted(() => vi.fn());
vi.mock("../../../../../utils/api", () => ({ authenticatedFetch: fetch }));
afterEach(() => { cleanup(); fetch.mockReset(); });
it.each(["en", "zh-CN"])("shows readable provider/engine labels in %s and tests the selected engine", async lng => {
  const i18n = createInstance(); await i18n.init({ lng, resources: { en: { settings: en }, "zh-CN": { settings: zh } }, defaultNS: "settings", interpolation: { escapeValue: false } });
  const change = vi.fn();
  const config = { tools: { webSearch: { enabled: true, provider: "serpapi" as const, searchEngine: "yahoo" as const, apiKey: "********" } } };
  render(<Provider i18n={i18n}><ToolsSection config={config} onChange={change} /></Provider>);
  const provider = screen.getByLabelText(lng === "en" ? "Search provider" : "搜索提供商");
  const help = screen.getByRole("link");
  expect(help.getAttribute("href")).toBe(WEB_SEARCH_DOCS.serpapi);
  expect(help.getAttribute("target")).toBe("_blank");
  fireEvent.focus(help);
  await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("SerpAPI"));
  fireEvent.keyDown(help, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBe(null);
  expect(provider.querySelectorAll("option")).toHaveLength(10);
  for (const option of provider.querySelectorAll("option")) expect(option.textContent).not.toContain("pilotDeckConfig.");
  expect(screen.getByRole("option", { name: "Serper (Google)" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Brave Search" })).toBeTruthy();
  const engine = screen.getByLabelText(lng === "en" ? "Search engine" : "搜索引擎");
  expect(engine.querySelectorAll("option")).toHaveLength(6);
  fireEvent.change(engine, { target: { value: "bing" } });
  expect(change.mock.calls[0][0].tools.webSearch.providers.serpapi).toEqual({ apiKey: "********", searchEngine: "bing" });
  fetch.mockResolvedValue({ json: async () => ({ ok: true, organicCount: 1 }) });
  fireEvent.click(screen.getByRole("button", { name: lng === "en" ? "Test connection" : "测试连接" }));
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ provider: "serpapi", searchEngine: "yahoo", apiKey: "********" });
  fireEvent.change(provider, { target: { value: "baidu" } });
  expect(change.mock.calls[1][0].tools.webSearch.apiKey).toBeUndefined();
  expect(change.mock.calls[1][0].tools.webSearch.providers.serpapi).toEqual({ apiKey: "********", searchEngine: "yahoo" });
});

it("keeps separately edited keys after switching, toggling and remounting", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { settings: en } }, defaultNS: "settings" });
  let saved: PilotDeckConfig = {
    tools: { webSearch: { enabled: true, provider: "glm", apiKey: "glm-original" } },
  };
  function Harness() {
    const [config, setConfig] = useState(saved);
    return <Provider i18n={i18n}><ToolsSection config={config} onChange={next => {
      saved = next;
      setConfig(next);
    }} /></Provider>;
  }
  const view = render(<Harness />);
  const key = () => screen.getByLabelText("API key") as HTMLInputElement;
  const select = (value: string) => fireEvent.change(screen.getByLabelText("Search provider"), { target: { value } });
  const editKey = (value: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(key(), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  };
  expect(key().value).toBe("glm-original");
  select("tavily");
  expect(key().value).toBe("");
  editKey("tavily-saved");
  select("glm");
  expect(key().value).toBe("glm-original");
  editKey("glm-updated");
  select("tavily");
  expect(key().value).toBe("tavily-saved");
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(screen.getByRole("switch"));
  expect(key().value).toBe("tavily-saved");
  fetch.mockResolvedValue({ json: async () => ({ ok: true }) });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ provider: "tavily", apiKey: "tavily-saved" });
  view.unmount();
  render(<Harness />);
  expect(key().value).toBe("tavily-saved");
  select("glm");
  expect(key().value).toBe("glm-updated");
  expect(saved.tools?.webSearch?.providers?.tavily?.apiKey).toBe("tavily-saved");
});

it("saves a changed custom URL without forwarding its masked key and survives remount", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { settings: en } }, defaultNS: "settings" });
  let saved: PilotDeckConfig = { tools: { webSearch: { enabled: true, provider: "custom", providers: {
    custom: { endpoint: "https://old.example/search", apiKey: "********", customProvider: { auth: "bearer", method: "POST" } },
    glm: { apiKey: "********" },
  } } } };
  function Harness() {
    const [config, setConfig] = useState(saved);
    return <Provider i18n={i18n}><ToolsSection config={config} onChange={next => { saved = next; setConfig(next); }} /></Provider>;
  }
  const view = render(<Harness />);
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  fireEvent.change(document.getElementById("search-endpoint")!, { target: { value: " https://new.example/search " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(saved.tools?.webSearch?.providers?.custom).toMatchObject({ endpoint: "https://new.example/search" });
  expect(saved.tools?.webSearch?.providers?.custom?.apiKey).toBeUndefined();
  expect(saved.tools?.webSearch?.providers?.glm?.apiKey).toBe("********");
  view.unmount(); render(<Harness />);
  expect((document.getElementById("search-endpoint") as HTMLInputElement).value).toBe("https://new.example/search");
});
