import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PilotDeckConfigProvider,
  usePilotDeckConfig,
} from "./usePilotDeckConfig";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  subscribe: vi.fn(),
  listener: null as ((message: unknown) => void) | null,
}));

vi.mock("../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("../contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ subscribe: mocks.subscribe }),
}));

type TestResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

function response(body: unknown, ok = true): TestResponse {
  return {
    ok,
    json: async () => body,
  };
}

function configResponse(raw: string, revision = `revision-${raw}`) {
  return {
    exists: true,
    path: "/tmp/pilotdeck.yaml",
    raw,
    revision,
    validation: {
      valid: true,
      errors: [],
      warnings: [],
    },
  };
}

function ConfigWrapper({ children }: { children: ReactNode }) {
  return <PilotDeckConfigProvider>{children}</PilotDeckConfigProvider>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("usePilotDeckConfig saves", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockReset();
    mocks.listener = null;
    mocks.subscribe.mockReset();
    mocks.subscribe.mockImplementation((listener) => {
      mocks.listener = listener;
      return vi.fn();
    });
  });

  it("serializes immediate saves and prevents an older response replacing the latest draft", async () => {
    const firstWrite = deferred<TestResponse>();
    const secondWrite = deferred<TestResponse>();
    const writeBodies: string[] = [];

    mocks.authenticatedFetch.mockImplementation(
      (url: string, options?: RequestInit) => {
        if (url === "/api/config" && !options?.method) {
          return Promise.resolve(response(configResponse("initial")));
        }
        if (url === "/api/config/validate") {
          return Promise.resolve(
            response({ valid: true, errors: [], warnings: [] }),
          );
        }
        if (url === "/api/config" && options?.method === "PUT") {
          writeBodies.push(String(options.body));
          return writeBodies.length === 1
            ? firstWrite.promise
            : secondWrite.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const { result } = renderHook(() => usePilotDeckConfig(), {
      wrapper: ConfigWrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstSave!: ReturnType<typeof result.current.save>;
    let secondSave!: ReturnType<typeof result.current.save>;
    act(() => {
      result.current.setRaw("first");
      firstSave = result.current.save();
      result.current.setRaw("second");
      secondSave = result.current.save();
    });

    await waitFor(() => expect(writeBodies).toHaveLength(1));
    expect(JSON.parse(writeBodies[0])).toEqual({
      raw: "first",
      baseRevision: "revision-initial",
    });

    act(() => {
      firstWrite.resolve(response(configResponse("first")));
    });
    await waitFor(() => expect(writeBodies).toHaveLength(2));

    act(() => {
      mocks.listener?.({
        type: "config:reloaded",
        source: "ui-save",
        ...configResponse("first"),
      });
    });
    expect(result.current.raw).toBe("second");
    expect(JSON.parse(writeBodies[1])).toEqual({
      raw: "second",
      baseRevision: "revision-first",
    });

    act(() => {
      secondWrite.resolve(response(configResponse("second")));
    });

    let results;
    await act(async () => {
      results = await Promise.all([firstSave, secondSave]);
    });

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(result.current.raw).toBe("second");
    expect(result.current.saving).toBe(false);
  });

  it("tracks the saved disk snapshot without replacing a newer raw draft", async () => {
    const write = deferred<TestResponse>();
    let writeStarted = false;

    mocks.authenticatedFetch.mockImplementation(
      (url: string, options?: RequestInit) => {
        if (url === "/api/config" && !options?.method) {
          return Promise.resolve(response(configResponse("initial")));
        }
        if (url === "/api/config/validate") {
          return Promise.resolve(
            response({ valid: true, errors: [], warnings: [] }),
          );
        }
        if (url === "/api/config" && options?.method === "PUT") {
          writeStarted = true;
          return write.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const { result } = renderHook(() => usePilotDeckConfig(), {
      wrapper: ConfigWrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saveResult!: ReturnType<typeof result.current.save>;
    act(() => {
      result.current.setRaw("saved while request is pending");
      saveResult = result.current.save();
      result.current.setRaw("initial");
    });
    await waitFor(() => expect(writeStarted).toBe(true));

    act(() => {
      write.resolve(
        response(configResponse("saved while request is pending")),
      );
    });
    await act(async () => {
      await saveResult;
    });

    expect(result.current.raw).toBe("initial");
    expect(result.current.isDirty).toBe(true);
    expect(result.current.saving).toBe(false);

    act(() => {
      mocks.listener?.({
        type: "config:reloaded",
        source: "ui-save",
        ...configResponse("saved while request is pending"),
      });
    });
    expect(result.current.raw).toBe("initial");
    expect(result.current.isDirty).toBe(true);
  });

  it("returns an explicit failure and exposes the server error", async () => {
    mocks.authenticatedFetch.mockImplementation(
      (url: string, options?: RequestInit) => {
        if (url === "/api/config" && !options?.method) {
          return Promise.resolve(response(configResponse("initial")));
        }
        if (url === "/api/config/validate") {
          return Promise.resolve(
            response({ valid: true, errors: [], warnings: [] }),
          );
        }
        if (url === "/api/config" && options?.method === "PUT") {
          return Promise.resolve(
            response({ error: "Config write rejected" }, false),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const { result } = renderHook(() => usePilotDeckConfig(), {
      wrapper: ConfigWrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saveResult;
    await act(async () => {
      result.current.setRaw("invalid");
      saveResult = await result.current.save();
    });

    expect(saveResult).toEqual({
      ok: false,
      error: "Config write rejected",
    });
    expect(result.current.error).toBe("Config write rejected");
    expect(result.current.saving).toBe(false);
  });

  it("shares one draft and save queue between settings consumers", async () => {
    mocks.authenticatedFetch.mockImplementation(
      (url: string, options?: RequestInit) => {
        if (url === "/api/config" && !options?.method) {
          return Promise.resolve(response(configResponse("initial")));
        }
        if (url === "/api/config/validate") {
          return Promise.resolve(
            response({ valid: true, errors: [], warnings: [] }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const { result } = renderHook(
      () => ({
        first: usePilotDeckConfig(),
        second: usePilotDeckConfig(),
      }),
      { wrapper: ConfigWrapper },
    );
    await waitFor(() => expect(result.current.first.loading).toBe(false));

    expect(result.current.first).toBe(result.current.second);
    act(() => {
      result.current.first.setRaw("shared draft");
    });
    expect(result.current.second.raw).toBe("shared draft");
  });

  it("only restores a failed optimistic draft when it is still current", async () => {
    mocks.authenticatedFetch.mockImplementation(
      (url: string, options?: RequestInit) => {
        if (url === "/api/config" && !options?.method) {
          return Promise.resolve(response(configResponse("initial")));
        }
        if (url === "/api/config/validate") {
          return Promise.resolve(
            response({ valid: true, errors: [], warnings: [] }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const { result } = renderHook(() => usePilotDeckConfig(), {
      wrapper: ConfigWrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setRaw("failed rename");
    });
    let restored = false;
    act(() => {
      restored = result.current.restoreRawIfCurrent(
        "failed rename",
        "initial",
      );
    });
    expect(restored).toBe(true);
    expect(result.current.raw).toBe("initial");

    act(() => {
      result.current.setRaw("newer draft");
      restored = result.current.restoreRawIfCurrent(
        "failed rename",
        "initial",
      );
    });
    expect(restored).toBe(false);
    expect(result.current.raw).toBe("newer draft");
  });
});
