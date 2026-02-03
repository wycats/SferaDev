import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseModelIdentity } from "./identity";

describe("parseModelIdentity", () => {
  it("roundtrips fullId", () => {
    fc.assert(
      fc.property(fc.string(), (modelId) => {
        expect(parseModelIdentity(modelId).fullId).toBe(modelId);
      }),
    );
  });

  it("extracts provider for colon-separated ids", () => {
    const segmentChar = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.".split(
        "",
      ),
    );
    const providerArb = fc.string({ unit: segmentChar, minLength: 1 });
    const modelPartArb = fc.string({ unit: segmentChar, minLength: 0 });

    fc.assert(
      fc.property(providerArb, modelPartArb, (provider, modelPart) => {
        const modelId = `${provider}:${modelPart}`;
        const result = parseModelIdentity(modelId);

        expect(result.provider).toBe(provider);
        expect(result.fullId).toBe(modelId);
      }),
    );
  });

  it("extracts provider for slash-separated ids", () => {
    const segmentChar = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.".split(
        "",
      ),
    );
    const providerArb = fc.string({ unit: segmentChar, minLength: 1 });
    const modelPartArb = fc.string({ unit: segmentChar, minLength: 0 });

    fc.assert(
      fc.property(providerArb, modelPartArb, (provider, modelPart) => {
        const modelId = `${provider}/${modelPart}`;
        const result = parseModelIdentity(modelId);

        expect(result.provider).toBe(provider);
        expect(result.fullId).toBe(modelId);
      }),
    );
  });

  it("strips version suffixes from family", () => {
    const digits = fc.constantFrom(..."0123456789".split(""));
    const familyChar = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-".split(
        "",
      ),
    );
    const familyArb = fc
      .string({ unit: familyChar, minLength: 1 })
      .filter((value) => !value.endsWith("-") && !value.endsWith("_"));

    const dateArb = fc
      .record({
        year: fc.integer({ min: 2000, max: 2099 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
      })
      .map(
        ({ year, month, day }) =>
          `${year.toString()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      );
    const compactDigitsArb = fc.string({
      unit: digits,
      minLength: 4,
      maxLength: 8,
    });
    const semverArb = fc
      .tuple(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
      )
      .map(([major, minor, patch]) =>
        patch === undefined
          ? `${major.toString()}.${minor.toString()}`
          : `${major.toString()}.${minor.toString()}.${patch.toString()}`,
      );
    const versionArb = fc.oneof(dateArb, compactDigitsArb, semverArb);
    const separatorArb = fc.constantFrom("-", "_");

    fc.assert(
      fc.property(
        familyArb,
        versionArb,
        separatorArb,
        (family, version, separator) => {
          const modelId = `provider:${family}${separator}${version}`;
          const result = parseModelIdentity(modelId);

          expect(result.family).toBe(family);
          expect(result.version).toBe(version);
          expect(result.family.endsWith(version)).toBe(false);
        },
      ),
    );
  });

  it("defaults version to latest when no suffix matches", () => {
    const safeChar = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.".split(
        "",
      ),
    );
    const modelPartArb = fc.string({ unit: safeChar, minLength: 1 });

    fc.assert(
      fc.property(modelPartArb, (modelPart) => {
        const result = parseModelIdentity(modelPart);
        expect(result.version).toBe("latest");
        expect(result.family).toBe(modelPart);
      }),
    );
  });

  it("handles edge cases", () => {
    const empty = parseModelIdentity("");
    expect(empty.provider).toBe("");
    expect(empty.family).toBe("");
    expect(empty.version).toBe("latest");
    expect(empty.fullId).toBe("");

    const noSeparator = parseModelIdentity("gpt-4o");
    expect(noSeparator.provider).toBe("");
    expect(noSeparator.family).toBe("gpt-4o");
    expect(noSeparator.version).toBe("latest");

    const multipleSeparators = parseModelIdentity("openai:family:extra");
    expect(multipleSeparators.provider).toBe("openai");
    expect(multipleSeparators.family).toBe("family:extra");
    expect(multipleSeparators.version).toBe("latest");

    const mixedSeparators = parseModelIdentity("openai/claude:sonnet");
    expect(mixedSeparators.provider).toBe("openai/claude");
    expect(mixedSeparators.family).toBe("sonnet");
  });
});
