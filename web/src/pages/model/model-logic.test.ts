import { describe, expect, it } from "vitest";
import type {
  BoardModel,
  BoardResponse,
  ResultSummary,
} from "../../../../shared/types.ts";
import {
  appendPage,
  findModel,
  followsLatest,
  parseId,
  refreshLimit,
  resultPath,
  runDescription,
} from "./model-logic";

const summary = (
  id: number,
  overrides: Partial<ResultSummary> = {},
): ResultSummary => ({
  id,
  status: "success",
  startedAt: "2026-10-12T00:00:00.000Z",
  finishedAt: "2026-10-12T00:00:05.000Z",
  durationMs: 5000,
  trigger: "schedule",
  ...overrides,
});

const ids = (list: { items: ResultSummary[] }) =>
  list.items.map((item) => item.id);

function model(id: number): BoardModel {
  return {
    id,
    model: `m-${id}`,
    displayName: `m-${id}`,
    stream: true,
    timeoutSeconds: 60,
    intervalMinutes: 60,
    lastRunAt: null,
    nextRunAt: null,
    running: false,
    checks: [],
  };
}

describe("parseId", () => {
  it("只认正整数", () => {
    expect(parseId("12")).toBe(12);
    for (const bad of [null, undefined, "", "0", "-1", "1.5", "1e3", "abc", "1".repeat(16)]) {
      expect(parseId(bad)).toBeNull();
    }
  });
});

describe("findModel", () => {
  it("找出模型和它所在的渠道，找不到是 null", () => {
    const board: BoardResponse = {
      site: { title: "t", description: "" },
      generatedAt: "2026-10-12T00:00:00.000Z",
      channels: [
        { id: 1, name: "甲", endpointType: "openai-chat", models: [model(5)] },
        { id: 2, name: "乙", endpointType: "gemini", models: [model(6), model(7)] },
      ],
    };
    const found = findModel(board, 7);
    expect(found?.channel.name).toBe("乙");
    expect(found?.model.id).toBe(7);
    expect(findModel(board, 8)).toBeNull();
  });
});

describe("resultPath / followsLatest", () => {
  it("某一次检测的地址带上题和记录", () => {
    expect(resultPath(3, 12, 99)).toBe("/models/3?prompt=12&result=99");
  });

  it("没选、或者选的正好是最新一次时跟着最新走", () => {
    expect(followsLatest(null, { id: 9 })).toBe(true);
    expect(followsLatest(9, { id: 9 })).toBe(true);
    expect(followsLatest(8, { id: 9 })).toBe(false);
    expect(followsLatest(null, null)).toBe(true);
    expect(followsLatest(8, null)).toBe(false);
  });
});

describe("runDescription", () => {
  it("耗时、手动；进行中的不写耗时", () => {
    expect(runDescription(summary(1))).toBe("耗时 5.0 秒");
    expect(runDescription(summary(1, { trigger: "manual" }))).toBe(
      "耗时 5.0 秒 · 手动",
    );
    expect(
      runDescription(summary(1, { status: "running", durationMs: null })),
    ).toBe("进行中");
    expect(runDescription(summary(1, { durationMs: null }))).toBe("—");
  });
});

describe("refreshLimit", () => {
  it("至少一页，加载过更多的照原样拉回来，最多 100 条", () => {
    expect(refreshLimit(0)).toBe(30);
    expect(refreshLimit(12)).toBe(30);
    expect(refreshLimit(60)).toBe(60);
    expect(refreshLimit(250)).toBe(100);
  });
});

describe("appendPage", () => {
  it("更早的一页接在后面，重叠的不重复", () => {
    const current = { items: [summary(9), summary(8)], hasMore: true };
    const list = appendPage(
      current,
      { items: [summary(8), summary(7), summary(6)], hasMore: false },
      8,
    );
    expect(ids(list)).toEqual([9, 8, 7, 6]);
    expect(list.hasMore).toBe(false);
  });

  it("请求在路上时列表被刷新成没有更多了，晚到的这页不要", () => {
    const current = { items: [summary(10)], hasMore: false };
    expect(
      appendPage(current, { items: [summary(7)], hasMore: true }, 10),
    ).toBe(current);
  });

  it("请求在路上时列表刷新过、最早的一条变了，这页接上去会漏记录，不要", () => {
    // 发请求时最早的是 71；刷新后整份列表往前挪了一条，最早的成了 72
    const current = {
      items: [summary(101), summary(100), summary(72)],
      hasMore: true,
    };
    expect(
      appendPage(current, { items: [summary(70), summary(69)], hasMore: true }, 71),
    ).toBe(current);
  });
});
