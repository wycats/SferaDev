import { describe, expect, it } from "vitest";
import type { AgentEntry } from "../status-bar.js";
import { formatTokens, getDisplayTokens } from "./display.js";

const baseAgent: AgentEntry = {
  id: "agent-1",
  name: "main",
  startTime: 0,
  lastUpdateTime: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastActualInputTokens: 0,
  totalOutputTokens: 0,
  turnCount: 1,
  status: "streaming",
  dimmed: false,
  isMain: true,
};

describe("getDisplayTokens", () => {
  it("returns anchored delta during streaming", () => {
    const agent = {
      ...baseAgent,
      status: "streaming",
      lastActualInputTokens: 1200,
      estimatedDeltaTokens: 300,
      estimatedInputTokens: 1500,
    } as AgentEntry;

    const result = getDisplayTokens(agent);

    expect(result).toEqual({ value: 1500, isEstimate: false });
  });

  it("returns full estimate during streaming without delta", () => {
    const agent = {
      ...baseAgent,
      status: "streaming",
      estimatedInputTokens: 800,
    } as AgentEntry;

    const result = getDisplayTokens(agent);

    expect(result).toEqual({ value: 800, isEstimate: true });
  });

  it("returns null when streaming without estimates", () => {
    const agent = {
      ...baseAgent,
      status: "streaming",
      estimatedInputTokens: undefined,
      estimatedDeltaTokens: undefined,
    } as AgentEntry;

    const result = getDisplayTokens(agent);

    expect(result).toBeNull();
  });

  it("returns single-turn actuals when complete", () => {
    const agent = {
      ...baseAgent,
      status: "complete",
      turnCount: 1,
      inputTokens: 500,
      lastActualInputTokens: 900,
    } as AgentEntry;

    const result = getDisplayTokens(agent);

    expect(result).toEqual({ value: 500, isEstimate: false });
  });

  it("returns accumulated actuals when complete and multi-turn", () => {
    const agent = {
      ...baseAgent,
      status: "complete",
      turnCount: 2,
      inputTokens: 600,
      lastActualInputTokens: 1200,
    } as AgentEntry;

    const result = getDisplayTokens(agent);

    expect(result).toEqual({ value: 1200, isEstimate: false });
  });

  it("returns actuals when errored", () => {
    const agent = {
      ...baseAgent,
      status: "error",
      turnCount: 2,
      inputTokens: 300,
      lastActualInputTokens: 700,
    } as AgentEntry;

    const result = getDisplayTokens(agent);

    expect(result).toEqual({ value: 700, isEstimate: false });
  });
});

describe("formatTokens", () => {
  it("formats small numbers", () => {
    expect(formatTokens(500)).toBe("500");
  });

  it("pads small numbers when requested", () => {
    const figureSpace = "\u2007";
    expect(formatTokens(5, { padded: true })).toBe(
      `${figureSpace}${figureSpace}5`,
    );
  });

  it("formats and pads thousands", () => {
    const figureSpace = "\u2007";
    expect(formatTokens(52300)).toBe("52.3k");
    expect(formatTokens(52300, { padded: true })).toBe(`${figureSpace}52.3k`);
  });

  it("formats and pads millions", () => {
    const figureSpace = "\u2007";
    expect(formatTokens(1200000)).toBe("1.2M");
    expect(formatTokens(1200000, { padded: true })).toBe(`${figureSpace}1.2M`);
  });
});
