import { describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { detectImageMimeType } from "./image-utils.js";

describe("detectImageMimeType", () => {
  it("detects PNG from magic bytes", () => {
    const data = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(detectImageMimeType(data, "image/*")).toBe("image/png");
  });

  it("detects JPEG from magic bytes", () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
    expect(detectImageMimeType(data, "image/*")).toBe("image/jpeg");
  });

  it("detects GIF from magic bytes", () => {
    const data = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageMimeType(data, "image/*")).toBe("image/gif");
  });

  it("detects WebP from RIFF header", () => {
    const data = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageMimeType(data, "image/*")).toBe("image/webp");
  });

  it("returns specific fallback without checking bytes", () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(detectImageMimeType(data, "image/jpeg")).toBe("image/jpeg");
  });

  it("uses wildcard fallback to trigger detection", () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(detectImageMimeType(data, "image/*")).toBe("image/png");
  });

  it("defaults to PNG for unknown bytes", () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    expect(detectImageMimeType(data, "image/*")).toBe("image/png");
  });
});
