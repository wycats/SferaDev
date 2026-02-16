import { describe, expect, it } from "vitest";
import { ulid } from "./ulid";

describe("ulid", () => {
  it("returns a 26-character string", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
  });

  it("uses only Crockford base32 characters", () => {
    const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toMatch(CROCKFORD_RE);
    }
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(ulid());
    }
    expect(ids.size).toBe(1000);
  });

  it("is monotonically increasing (lexicographic sort = generation order)", () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(ulid());
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
