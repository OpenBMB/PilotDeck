import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TranscriptionSection from "./TranscriptionSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("TranscriptionSection", () => {
  it("creates the complete safe default configuration when transcription is enabled", () => {
    const onChange = vi.fn();
    render(<TranscriptionSection config={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole("switch", {
      name: "pilotDeckConfig.panels.transSpeech.enabled.label",
    }));

    expect(onChange).toHaveBeenCalledWith({
      tools: {
        transSpeech: {
          enabled: true,
          baseUrl: "http://trans-speech:8090",
          language: "zh",
          asrProfile: "sensevoice",
          diarize: true,
          timeoutMs: 330000,
          maxConcurrentTasks: 1,
          generate: { polish: true, minutes: true, actions: false },
        },
      },
    });
  });

  it("shows every transcription setting for an enabled service", () => {
    render(
      <TranscriptionSection
        config={{
          tools: {
            transSpeech: {
              enabled: true,
              baseUrl: "http://172.16.21.9:8090",
              language: "zh",
              asrProfile: "sensevoice",
              diarize: true,
              timeoutMs: 330000,
              maxConcurrentTasks: 1,
              generate: { polish: true, minutes: true, actions: false },
            },
          },
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue("http://172.16.21.9:8090")).toBeTruthy();
    expect(screen.getByDisplayValue("zh")).toBeTruthy();
    expect(screen.getByDisplayValue("sensevoice")).toBeTruthy();
    expect(screen.getByDisplayValue("330000")).toBeTruthy();
    expect(screen.getByDisplayValue("1")).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(5);
  });

  it("turns action items off when meeting minutes are disabled", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TranscriptionSection
        config={{
          tools: {
            transSpeech: {
              enabled: true,
              baseUrl: "http://trans-speech:8090",
              language: "zh",
              asrProfile: "sensevoice",
              diarize: true,
              timeoutMs: 330000,
              maxConcurrentTasks: 1,
              generate: { polish: true, minutes: true, actions: true },
            },
          },
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("switch", {
      name: "pilotDeckConfig.panels.transSpeech.generate.minutes.label",
    }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.objectContaining({
        transSpeech: expect.objectContaining({
          generate: { polish: true, minutes: false, actions: false },
        }),
      }),
    }));
    rerender(
      <TranscriptionSection
        config={{
          tools: {
            transSpeech: {
              enabled: true,
              baseUrl: "http://trans-speech:8090",
              language: "zh",
              asrProfile: "sensevoice",
              diarize: true,
              timeoutMs: 330000,
              maxConcurrentTasks: 1,
              generate: { polish: true, minutes: false, actions: false },
            },
          },
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("switch", {
      name: "pilotDeckConfig.panels.transSpeech.generate.actions.label",
    }).hasAttribute("disabled")).toBe(true);
  });
});
