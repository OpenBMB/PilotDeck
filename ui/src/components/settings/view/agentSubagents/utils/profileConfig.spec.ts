import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_TOOLS,
  getMaxDepth,
  getProfiles,
  makeCustomProfile,
  newCustomProfileId,
  sanitizeTools,
  validateMaxDepth,
  validateProfileDraft,
  withMaxDepth,
  withProfiles,
} from "./profileConfig";

const configuredModelRefs = ["prov/model-a", "prov/model-b"];

function baseConfig() {
  return {
    agent: {
      model: "prov/model-a",
      subagents: {
        default: "inherit",
        timeoutMs: 60000,
        profiles: { a: { description: "existing" } },
      },
    },
    model: { providers: {} },
  } as any;
}

describe("newCustomProfileId", () => {
  it("generates a unique safe slug", () => {
    expect(newCustomProfileId([])).toBe("profile-1");
    expect(newCustomProfileId(["profile-1"])).toBe("profile-2");
    expect(
      newCustomProfileId(["profile-1", "profile-2", "profile-3"]),
    ).toBe("profile-4");
  });

  it("skips reserved ids even when free", () => {
    // "profile-1" style candidates never collide with reserved names, but the
    // generator must still never hand out a reserved id.
    expect(newCustomProfileId(["general_purpose", "__proto__"])).toBe(
      "profile-1",
    );
  });
});

describe("makeCustomProfile", () => {
  it("defaults to enabled read-only with the standard toolset", () => {
    expect(makeCustomProfile("desc")).toEqual({
      description: "desc",
      tools: ["read_file", "grep", "glob"],
      readOnly: true,
      enabled: true,
    });
    expect(DEFAULT_CUSTOM_TOOLS).toEqual(["read_file", "grep", "glob"]);
  });
});

describe("sanitizeTools", () => {
  it("keeps only string entries and passes through non-arrays as undefined", () => {
    expect(sanitizeTools(["read_file", 1, "grep"])).toEqual([
      "read_file",
      "grep",
    ]);
    expect(sanitizeTools(undefined)).toBeUndefined();
    expect(sanitizeTools("read_file")).toBeUndefined();
  });
});

describe("getProfiles / getMaxDepth", () => {
  it("reads the raw config sections defensively", () => {
    const config = baseConfig();
    expect(Object.keys(getProfiles(config) ?? {})).toEqual(["a"]);
    expect(getMaxDepth(config)).toBeUndefined();
    expect(getMaxDepth({ agent: { subagents: { maxDepth: 2 } } } as any)).toBe(2);
    expect(getMaxDepth({ agent: { subagents: { maxDepth: 1.5 } } } as any)).toBeUndefined();
    expect(getProfiles({ agent: {} } as any)).toBeUndefined();
  });
});

describe("withProfiles", () => {
  it("replaces profiles while preserving legacy subagent keys and unrelated config", () => {
    const next = withProfiles(baseConfig(), { b: makeCustomProfile("y") });
    expect(Object.keys(next.agent?.subagents?.profiles ?? {})).toEqual(["b"]);
    expect(next.agent?.subagents?.default).toBe("inherit");
    expect(next.agent?.subagents?.timeoutMs).toBe(60000);
    expect(next.agent?.model).toBe("prov/model-a");
    expect(next.model).toEqual({ providers: {} });
  });

  it("drops the profiles key while keeping default and timeoutMs", () => {
    const next = withProfiles(baseConfig(), undefined);
    expect(next.agent?.subagents).toEqual({ default: "inherit", timeoutMs: 60000 });
  });

  it("removes an empty subagents section entirely", () => {
    const next = withProfiles({ agent: { subagents: { profiles: { a: { description: "x" } } } } } as any, undefined);
    expect(next.agent).toBeUndefined();
  });
});

describe("withMaxDepth", () => {
  it("writes and clears maxDepth without touching sibling keys", () => {
    const withDepth = withMaxDepth(baseConfig(), 2);
    expect(withDepth.agent?.subagents?.maxDepth).toBe(2);
    expect(withDepth.agent?.subagents?.timeoutMs).toBe(60000);
    expect(withDepth.agent?.subagents?.default).toBe("inherit");

    const cleared = withMaxDepth(withDepth, undefined);
    expect(cleared.agent?.subagents?.maxDepth).toBeUndefined();
    expect(cleared.agent?.subagents?.default).toBe("inherit");
  });
});

describe("validateMaxDepth", () => {
  it("accepts unset and integer depths within the limit", () => {
    expect(validateMaxDepth(undefined, 5)).toBeNull();
    expect(validateMaxDepth(0, 5)).toBeNull();
    expect(validateMaxDepth(5, 5)).toBeNull();
  });

  it("rejects out-of-range, fractional and non-numeric depths", () => {
    expect(validateMaxDepth(6, 5)).toBeTruthy();
    expect(validateMaxDepth(-1, 5)).toBeTruthy();
    expect(validateMaxDepth(1.5, 5)).toBeTruthy();
    expect(validateMaxDepth("2", 5)).toBeTruthy();
  });
});

describe("validateProfileDraft", () => {
  const baseArgs = {
    profile: makeCustomProfile("ok"),
    otherIds: [] as string[],
    configuredModelRefs,
    idEditable: true,
    descriptionRequired: true,
  };

  it("accepts a valid custom profile", () => {
    expect(validateProfileDraft({ ...baseArgs, id: "vision" })).toEqual({});
  });

  it("requires a non-whitespace description for custom profiles", () => {
    expect(
      validateProfileDraft({ ...baseArgs, id: "vision", profile: makeCustomProfile("") })
        .description,
    ).toBeTruthy();
    expect(
      validateProfileDraft({ ...baseArgs, id: "vision", profile: makeCustomProfile("   ") })
        .description,
    ).toBeTruthy();
  });

  it("bounds the description length without truncating", () => {
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: makeCustomProfile("x".repeat(2000)),
      }).description,
    ).toBeUndefined();
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: makeCustomProfile("x".repeat(2001)),
      }).description,
    ).toBeTruthy();
  });

  it("does not require a description for builtin overrides", () => {
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "explore",
        descriptionRequired: false,
        profile: { enabled: false },
      }),
    ).toEqual({});
  });

  it("rejects invalid, reserved and duplicate ids", () => {
    const idError = (id: string, otherIds: string[] = []) =>
      validateProfileDraft({ ...baseArgs, id, otherIds }).id;
    expect(idError("")).toBeTruthy();
    expect(idError("Vision")).toBeTruthy();
    expect(idError("-bad")).toBeTruthy();
    expect(idError("a".repeat(65))).toBeTruthy();
    expect(idError("general_purpose")).toBeTruthy();
    expect(idError("__proto__")).toBeTruthy();
    expect(idError("vision", ["vision"])).toBeTruthy();
    expect(idError("vision-2", ["vision"])).toBeUndefined();
  });

  it("skips id validation for saved profiles whose id is immutable", () => {
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        idEditable: false,
        profile: makeCustomProfile("ok"),
        otherIds: ["vision"],
      }).id,
    ).toBeUndefined();
  });

  it("rejects unconfigured model references and accepts configured ones", () => {
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: { ...makeCustomProfile("ok"), model: "prov/unknown" },
      }).model,
    ).toBeTruthy();
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: { ...makeCustomProfile("ok"), model: "prov/model-b" },
      }).model,
    ).toBeUndefined();
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: { ...makeCustomProfile("ok"), model: "inherit" },
      }).model,
    ).toBeUndefined();
  });

  it("rejects whitespace-only and duplicate tool ids", () => {
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: { ...makeCustomProfile("ok"), tools: ["read_file", "   "] },
      }).tools,
    ).toBeTruthy();
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: { ...makeCustomProfile("ok"), tools: ["read_file", "read_file"] },
      }).tools,
    ).toBeTruthy();
    expect(
      validateProfileDraft({
        ...baseArgs,
        id: "vision",
        profile: { ...makeCustomProfile("ok"), tools: ["read_file", "grep"] },
      }).tools,
    ).toBeUndefined();
  });

  it("rejects widening a read-only builtin preset beyond its preset tools plus agent", () => {
    const args = {
      ...baseArgs,
      id: "explore",
      idEditable: false,
      descriptionRequired: false,
      permittedTools: ["read_file", "grep", "glob", "bash"],
    };
    expect(
      validateProfileDraft({ ...args, profile: { tools: ["read_file", "write_file"] } }).tools,
    ).toBeTruthy();
    expect(
      validateProfileDraft({ ...args, profile: { tools: ["read_file", "agent"] } }).tools,
    ).toBeUndefined();
    expect(
      validateProfileDraft({ ...args, profile: { tools: ["read_file"] } }).tools,
    ).toBeUndefined();
  });
});
