import { describe, expect, it } from "vitest";
import type { AdminModel, AdminPrompt } from "../../../../shared/types.ts";
import {
  anyRunning,
  describeNextRun,
  filterModels,
  modelLabel,
  promptStats,
  runnablePrompts,
  runToast,
} from "./model-list";

const NOW = "2026-10-11T00:00:00.000Z";

function model(overrides: Partial<AdminModel> = {}): AdminModel {
  return {
    id: 1,
    channelId: 1,
    channelName: "渠道",
    model: "gpt-4o",
    displayName: "",
    stream: true,
    timeoutSeconds: 120,
    intervalMinutes: 60,
    maxTokens: null,
    temperature: null,
    enabled: true,
    sortOrder: 0,
    promptIds: [],
    lastRunAt: null,
    nextRunAt: null,
    running: false,
    lastStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function prompt(id: number, enabled = true): AdminPrompt {
  return {
    id,
    title: `题 ${id}`,
    content: "",
    enabled,
    sortOrder: 0,
    modelIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("modelLabel", () => {
  it("有显示名用显示名，否则用模型 ID", () => {
    expect(modelLabel({ displayName: "GPT-4o", model: "gpt-4o" })).toBe(
      "GPT-4o",
    );
    expect(modelLabel({ displayName: "  ", model: "gpt-4o" })).toBe("gpt-4o");
  });
});

describe("filterModels", () => {
  const models = [
    model({ id: 1, channelId: 1, model: "gpt-4o", displayName: "旗舰" }),
    model({ id: 2, channelId: 2, model: "claude-sonnet-4-5", displayName: "" }),
    model({
      id: 3,
      channelId: 2,
      model: "gemini-2.5-pro",
      displayName: "Gemini Pro",
    }),
  ];

  it("不筛选时全部返回", () => {
    expect(filterModels(models, { channelId: null, query: "" })).toHaveLength(
      3,
    );
  });

  it("按渠道筛选", () => {
    expect(
      filterModels(models, { channelId: 2, query: "" }).map((item) => item.id),
    ).toEqual([2, 3]);
  });

  it("按显示名或模型 ID 搜索，不分大小写", () => {
    expect(
      filterModels(models, { channelId: null, query: " CLAUDE " }).map(
        (item) => item.id,
      ),
    ).toEqual([2]);
    expect(
      filterModels(models, { channelId: null, query: "旗舰" }).map(
        (item) => item.id,
      ),
    ).toEqual([1]);
    expect(
      filterModels(models, { channelId: null, query: "pro" }).map(
        (item) => item.id,
      ),
    ).toEqual([3]);
  });

  it("渠道和搜索同时生效", () => {
    expect(filterModels(models, { channelId: 1, query: "gemini" })).toEqual([]);
  });
});

describe("promptStats", () => {
  it("区分启用和停用的提示词，忽略已不存在的", () => {
    expect(
      promptStats({ promptIds: [1, 2, 3, 99] }, [
        prompt(1),
        prompt(2, false),
        prompt(3),
      ]),
    ).toEqual({ assigned: 4, enabled: 2, disabled: 1 });
  });

  it("提示词还没载入时都当作启用", () => {
    expect(promptStats({ promptIds: [1, 2] }, undefined)).toEqual({
      assigned: 2,
      enabled: 2,
      disabled: 0,
    });
  });

  it("没有分配", () => {
    expect(promptStats({ promptIds: [] }, [prompt(1)])).toEqual({
      assigned: 0,
      enabled: 0,
      disabled: 0,
    });
  });
});

describe("runnablePrompts", () => {
  it("只要分配了且启用的，按提示词列表的顺序", () => {
    const prompts = [prompt(3), prompt(1), prompt(2, false), prompt(4)];
    expect(
      runnablePrompts(model({ promptIds: [1, 2, 3, 9] }), prompts).map(
        (item) => item.id,
      ),
    ).toEqual([3, 1]);
  });

  it("提示词列表还没载入时一条都没有", () => {
    expect(runnablePrompts(model({ promptIds: [1] }), undefined)).toEqual([]);
  });
});

describe("runToast", () => {
  it("排上了是成功，正在检测时是提示", () => {
    expect(runToast(true)).toEqual({ message: "已开始检测", tone: "success" });
    expect(runToast(false)).toEqual({
      message: "这个模型正在检测中",
      tone: "info",
    });
  });
});

describe("describeNextRun", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const ok = { channelEnabled: true, enabledPrompts: 2 };

  it("检测中优先", () => {
    expect(
      describeNextRun(model({ running: true, enabled: false }), ok, now),
    ).toEqual({
      kind: "running",
    });
  });

  it("模型停用、渠道停用、没有检测题时不会检测", () => {
    expect(describeNextRun(model({ enabled: false }), ok, now).kind).toBe(
      "model-disabled",
    );
    expect(
      describeNextRun(
        model(),
        { channelEnabled: false, enabledPrompts: 2 },
        now,
      ).kind,
    ).toBe("channel-disabled");
    expect(
      describeNextRun(model(), { channelEnabled: true, enabledPrompts: 0 }, now)
        .kind,
    ).toBe("no-prompts");
  });

  it("从没检测过或已经到期：即将开始", () => {
    expect(describeNextRun(model({ nextRunAt: null }), ok, now).kind).toBe(
      "soon",
    );
    expect(
      describeNextRun(model({ nextRunAt: "2026-10-11T11:59:00.000Z" }), ok, now)
        .kind,
    ).toBe("soon");
    expect(
      describeNextRun(model({ nextRunAt: "不是时间" }), ok, now).kind,
    ).toBe("soon");
  });

  it("将来的时间原样给出", () => {
    expect(
      describeNextRun(
        model({ nextRunAt: "2026-10-11T13:00:00.000Z" }),
        ok,
        now,
      ),
    ).toEqual({
      kind: "at",
      at: "2026-10-11T13:00:00.000Z",
    });
  });
});

describe("anyRunning", () => {
  it("有一个在跑就是 true", () => {
    expect(anyRunning([])).toBe(false);
    expect(anyRunning([{ running: false }, { running: true }])).toBe(true);
  });
});
