import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const mockGetConfiguration = vi.fn();

  return {
    mockGetConfiguration,
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: hoisted.mockGetConfiguration,
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import * as fs from "node:fs";
import { logger } from "../logger.js";
import { saveSuspiciousRequest } from "./debug-utils.js";
import type { CreateResponseBody } from "openresponses-client";

const baseContext = {
  timestamp: "2026-02-03T00:00:00.000Z",
  finishReason: "stop",
  textPartCount: 1,
  toolCallCount: 0,
  toolsProvided: 1,
  textPreview: "preview",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const baseRequestBody = {
  model: "test-model",
} as unknown as CreateResponseBody;

describe("saveSuspiciousRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue("/tmp/workspace");
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips writing when forensicCapture is disabled", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn(() => false),
    });

    saveSuspiciousRequest(baseRequestBody, baseContext);

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "[OpenResponses] Skipping suspicious request capture (forensicCapture disabled)",
    );
  });

  it("writes a suspicious request file when forensicCapture is enabled", () => {
    hoisted.mockGetConfiguration.mockReturnValue({
      get: vi.fn(() => true),
    });

    saveSuspiciousRequest(baseRequestBody, baseContext);

    expect(fs.existsSync).toHaveBeenCalledWith("/tmp/workspace/.logs");
    expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/workspace/.logs", {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/workspace/.logs/last-suspicious-request.json",
      expect.stringContaining("\"request\""),
    );
  });
});
