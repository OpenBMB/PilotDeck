import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogPicker from "./CatalogPicker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("CatalogPicker default selection", () => {
  afterEach(() => {
    cleanup();
  });

  it("selects the custom provider by default when opened", () => {
    render(
      <CatalogPicker
        open
        existingIds={new Set()}
        onPick={vi.fn()}
        onCustom={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const custom = screen.getByRole("button", {
      name: /pilotDeckConfig.panels.models.customProvider/,
    });
    expect(custom.classList.contains("selected")).toBe(true);
    expect(custom.getAttribute("aria-pressed")).toBe("true");

    const catalogOption = screen.getByRole("button", { name: "Anthropic" });
    expect(catalogOption.classList.contains("selected")).toBe(false);
  });
});
