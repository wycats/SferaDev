import { describe, it, expect } from "vitest";
import {
  computeToolSetHash,
  computeAgentTypeHash,
  hashUserMessage,
} from "./hash-utils.js";

describe("computeToolSetHash", () => {
  it("produces same hash regardless of tool order", () => {
    const tools1 = [{ name: "read_file" }, { name: "write_file" }];
    const tools2 = [{ name: "write_file" }, { name: "read_file" }];
    expect(computeToolSetHash(tools1 as any)).toBe(
      computeToolSetHash(tools2 as any),
    );
  });

  it("produces different hash for different tool sets", () => {
    const tools1 = [{ name: "read_file" }];
    const tools2 = [{ name: "write_file" }];
    expect(computeToolSetHash(tools1 as any)).not.toBe(
      computeToolSetHash(tools2 as any),
    );
  });

  it("returns 16-character hex string", () => {
    const hash = computeToolSetHash([{ name: "test" }] as any);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("computeAgentTypeHash", () => {
  it("returns a 16-character prefix of the tool set hash", () => {
    const hash = computeAgentTypeHash("def456def456def456");
    expect(hash).toBe("def456def456def4");
  });

  it("produces different hashes for different tool set hashes", () => {
    const hash1 = computeAgentTypeHash("abc123abc123abc123");
    const hash2 = computeAgentTypeHash("def456def456def456");
    expect(hash1).not.toBe(hash2);
  });
});

describe("hashUserMessage", () => {
  it("trims whitespace", () => {
    const hash1 = hashUserMessage("  test  ");
    const hash2 = hashUserMessage("test");
    expect(hash1).toBe(hash2);
  });
});
