import { describe, expect, it } from "vitest";
import type {
  BoardCheck,
  BoardModel,
  BoardResponse,
  ResultDetail,
} from "../../../../shared/types.ts";
import { formatDateTime } from "../../lib/format";
import {
  POLL_ACTIVE_MS,
  POLL_DUE_GRACE_MS,
  POLL_IDLE_MS,
  POLL_MAX_BACKOFF_MS,
  POLL_RETRY_MS,
  changedSnapshot,
  checkMark,
  clockOffset,
  computeBoardStats,
  describeNextRun,
  elapsedText,
  formatClock,
  hasOutput,
  isBoardActive,
  latestVersion,
  modelHeading,
  modelPath,
  modelProblems,
  nextPollDelay,
  nextRunText,
  pickTab,
  relativeParts,
  resolveCheckDisplay,
  resultMeta,
  runningCheck,
  tocEntries,
} from "./board-logic";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;

let nextId = 1;

function result(overrides: Partial<ResultDetail> = {}): ResultDetail {
  return {
    id: nextId++,
    modelId: 1,
    promptId: 1,
    promptSnapshot: "9.11 和 9.9 哪个大？",
    status: "success",
    stream: true,
    output: "9.9 更大。",
    reasoning: "",
    error: null,
    startedAt: iso(-10 * MIN),
    finishedAt: iso(-10 * MIN + 5000),
    durationMs: 5000,
    firstTokenMs: 800,
    inputTokens: 20,
    outputTokens: 1234,
    finishReason: "stop",
    trigger: "schedule",
    ...overrides,
  };
}

function check(
  promptId: number,
  latest: ResultDetail | null = null,
  previous: ResultDetail | null = null,
): BoardCheck {
  return {
    prompt: {
      id: promptId,
      title: `题 ${promptId}`,
      content: "9.11 和 9.9 哪个大？",
    },
    latest,
    previous,
  };
}

function model(overrides: Partial<BoardModel> = {}): BoardModel {
  return {
    id: nextId++,
    model: "gpt-4o",
    displayName: "gpt-4o",
    stream: true,
    timeoutSeconds: 120,
    intervalMinutes: 60,
    lastRunAt: null,
    nextRunAt: null,
    running: false,
    checks: [],
    ...overrides,
  };
}

function board(...channels: BoardModel[][]): BoardResponse {
  return {
    site: { title: "模型智商检测", description: "" },
    generatedAt: iso(0),
    channels: channels.map((models, index) => ({
      id: index + 1,
      name: `渠道 ${index + 1}`,
      endpointType: "openai-chat",
      models,
    })),
  };
}

describe("isBoardActive", () => {
  it("没有数据、没有模型时不算在跑", () => {
    expect(isBoardActive(undefined)).toBe(false);
    expect(isBoardActive(board())).toBe(false);
    expect(isBoardActive(board([]))).toBe(false);
  });

  it("模型在跑或排队时算在跑", () => {
    expect(isBoardActive(board([model()], [model({ running: true })]))).toBe(
      true,
    );
  });

  it("模型没标 running 但有记录还在进行时也算", () => {
    const m = model({ checks: [check(1, result({ status: "running" }))] });
    expect(isBoardActive(board([m]))).toBe(true);
  });

  it("全部结束时不算", () => {
    const m = model({ checks: [check(1, result()), check(2, null)] });
    expect(isBoardActive(board([m]))).toBe(false);
  });
});

describe("nextPollDelay", () => {
  const idle = board([model()]);
  const active = board([model({ running: true })]);
  /** 一个有检测题、下次检测在 offset 毫秒之后的空闲模型 */
  const dueIn = (offset: number | null) =>
    model({
      checks: [check(1, result())],
      nextRunAt: offset === null ? null : iso(offset),
    });

  it("平时 30 秒，有检测进行时 3 秒", () => {
    expect(nextPollDelay(idle, 0, NOW)).toBe(POLL_IDLE_MS);
    expect(nextPollDelay(active, 0, NOW)).toBe(POLL_ACTIVE_MS);
  });

  it("还没有数据时用重试间隔", () => {
    expect(nextPollDelay(undefined, 0, NOW)).toBe(POLL_RETRY_MS);
  });

  it("下次检测在 30 秒以内时，到点后 2 秒拉一次", () => {
    expect(nextPollDelay(board([dueIn(10_000)]), 0, NOW)).toBe(12_000);
    expect(nextPollDelay(board([dueIn(27_000)]), 0, NOW)).toBe(29_000);
    // 夹在 3 秒和 30 秒之间
    expect(nextPollDelay(board([dueIn(500)]), 0, NOW)).toBe(POLL_ACTIVE_MS);
    expect(nextPollDelay(board([dueIn(29_000)]), 0, NOW)).toBe(POLL_IDLE_MS);
  });

  it("还远时照旧 30 秒；从没检测过、没有检测题的模型不算", () => {
    expect(nextPollDelay(board([dueIn(5 * MIN)]), 0, NOW)).toBe(POLL_IDLE_MS);
    expect(nextPollDelay(board([dueIn(null)]), 0, NOW)).toBe(POLL_IDLE_MS);
    expect(
      nextPollDelay(board([model({ nextRunAt: iso(5_000) })]), 0, NOW),
    ).toBe(POLL_IDLE_MS);
  });

  it("多个模型取最早到点的那个", () => {
    const b = board([dueIn(5 * MIN), dueIn(20_000)], [dueIn(8_000)]);
    expect(nextPollDelay(b, 0, NOW)).toBe(10_000);
  });

  it("到点了还没开始时按检测中的间隔拉，但到点超过 2 分钟就不再快拉", () => {
    expect(nextPollDelay(board([dueIn(0)]), 0, NOW)).toBe(POLL_ACTIVE_MS);
    expect(nextPollDelay(board([dueIn(-30_000)]), 0, NOW)).toBe(
      POLL_ACTIVE_MS,
    );
    expect(nextPollDelay(board([dueIn(-POLL_DUE_GRACE_MS)]), 0, NOW)).toBe(
      POLL_ACTIVE_MS,
    );
    expect(nextPollDelay(board([dueIn(-POLL_DUE_GRACE_MS - 1)]), 0, NOW)).toBe(
      POLL_IDLE_MS,
    );
    // 卡住的那个不影响别的模型快到点
    const b = board([dueIn(-10 * MIN), dueIn(15_000)]);
    expect(nextPollDelay(b, 0, NOW)).toBe(17_000);
  });

  it("用传进来的（按服务器时钟校正过的）时间算", () => {
    const b = board([dueIn(5 * MIN)]);
    expect(nextPollDelay(b, 0, NOW)).toBe(POLL_IDLE_MS);
    expect(nextPollDelay(b, 0, NOW + 5 * MIN - 10_000)).toBe(12_000);
  });

  it("连续失败时翻倍退避，封顶 60 秒", () => {
    expect(nextPollDelay(active, 1, NOW)).toBe(POLL_ACTIVE_MS * 2);
    expect(nextPollDelay(active, 2, NOW)).toBe(POLL_ACTIVE_MS * 4);
    expect(nextPollDelay(active, 10, NOW)).toBe(POLL_MAX_BACKOFF_MS);
    expect(nextPollDelay(undefined, 1, NOW)).toBe(POLL_RETRY_MS * 2);
    expect(nextPollDelay(idle, 1, NOW)).toBe(POLL_MAX_BACKOFF_MS);
    expect(nextPollDelay(idle, 50, NOW)).toBe(POLL_MAX_BACKOFF_MS);
    // 快到点时的间隔同样按失败次数退避
    expect(nextPollDelay(board([dueIn(10_000)]), 1, NOW)).toBe(24_000);
    expect(nextPollDelay(board([dueIn(-5_000)]), 3, NOW)).toBe(
      POLL_ACTIVE_MS * 8,
    );
  });

  it("退避不会比正常间隔还短", () => {
    const soon = board([dueIn(10_000)]);
    for (let failures = 0; failures < 8; failures++) {
      expect(nextPollDelay(idle, failures, NOW)).toBeGreaterThanOrEqual(
        POLL_IDLE_MS,
      );
      expect(nextPollDelay(soon, failures, NOW)).toBeGreaterThanOrEqual(
        12_000,
      );
    }
  });
});

describe("clockOffset", () => {
  it("返回服务器比浏览器快的毫秒数", () => {
    expect(clockOffset(iso(5 * MIN), NOW)).toBe(5 * MIN);
    expect(clockOffset(iso(-90_000), NOW)).toBe(-90_000);
  });

  it("一秒以内当作网络延迟，不纠正", () => {
    expect(clockOffset(iso(400), NOW)).toBe(0);
    expect(clockOffset(iso(-999), NOW)).toBe(0);
  });

  it("时间解析不了时不纠正", () => {
    expect(clockOffset("garbage", NOW)).toBe(0);
    expect(clockOffset(iso(5 * MIN), Number.NaN)).toBe(0);
  });
});

describe("computeBoardStats", () => {
  it("空的看板", () => {
    expect(computeBoardStats(board())).toEqual({
      channels: 0,
      models: 0,
      prompts: 0,
      running: 0,
      lastCheckAt: null,
    });
  });

  it("渠道、模型计数，检测题按提示词去重，最近检测取最晚的时间", () => {
    const a = model({
      lastRunAt: iso(-30 * MIN),
      checks: [check(1, result({ startedAt: iso(-30 * MIN) })), check(2)],
    });
    const b = model({
      running: true,
      lastRunAt: iso(-2 * MIN),
      checks: [
        check(2, result({ startedAt: iso(-1 * MIN), status: "running" })),
      ],
    });
    const c = model({ checks: [check(3)] });
    const stats = computeBoardStats(board([a, b], [], [c]));
    expect(stats).toEqual({
      channels: 3,
      models: 3,
      prompts: 3,
      running: 1,
      lastCheckAt: iso(-1 * MIN),
    });
  });

  it("模型的 lastRunAt 比记录晚时用它（新一轮刚开始、还没写记录）", () => {
    const m = model({
      lastRunAt: iso(-5_000),
      checks: [check(1, result({ startedAt: iso(-60 * MIN) }))],
    });
    expect(computeBoardStats(board([m])).lastCheckAt).toBe(iso(-5_000));
  });

  it("忽略解析不了的时间", () => {
    const m = model({
      lastRunAt: "bad",
      checks: [check(1, result({ startedAt: iso(-MIN) }))],
    });
    expect(computeBoardStats(board([m])).lastCheckAt).toBe(iso(-MIN));
  });
});

describe("relativeParts", () => {
  it("把数字和单位拆开", () => {
    expect(relativeParts(iso(-3 * MIN), NOW)).toEqual({
      value: "3",
      unit: "分钟前",
    });
    expect(relativeParts(iso(-5 * 60 * MIN), NOW)).toEqual({
      value: "5",
      unit: "小时前",
    });
  });

  it("没有数字时整段作为值", () => {
    expect(relativeParts(iso(-10_000), NOW)).toEqual({
      value: "刚刚",
      unit: null,
    });
    expect(relativeParts(null, NOW)).toEqual({ value: "—", unit: null });
  });
});

describe("modelHeading", () => {
  it("显示名和模型 ID 相同或没填时只给标题", () => {
    expect(modelHeading({ model: "gpt-4o", displayName: "gpt-4o" })).toEqual({
      title: "gpt-4o",
      modelId: null,
    });
    expect(modelHeading({ model: "gpt-4o", displayName: "  " })).toEqual({
      title: "gpt-4o",
      modelId: null,
    });
  });

  it("不同时另给出模型 ID", () => {
    expect(
      modelHeading({ model: " claude-x ", displayName: "Claude X" }),
    ).toEqual({
      title: "Claude X",
      modelId: "claude-x",
    });
  });
});

describe("describeNextRun / nextRunText", () => {
  it("在跑时显示检测中", () => {
    const info = describeNextRun(
      model({ running: true, checks: [check(1)] }),
      NOW,
    );
    expect(info).toEqual({ state: "running" });
    expect(nextRunText(info)).toBe("检测中");
  });

  it("没有检测题时不会检测", () => {
    const info = describeNextRun(model({ nextRunAt: iso(MIN) }), NOW);
    expect(info).toEqual({ state: "idle" });
    expect(nextRunText(info)).toBe("没有检测题");
  });

  it("从没检测过时等待首次检测", () => {
    const info = describeNextRun(model({ checks: [check(1)] }), NOW);
    expect(info).toEqual({ state: "pending" });
    expect(nextRunText(info)).toBe("等待首次检测");
  });

  it("时间已到或不到一分钟时是即将开始", () => {
    for (const offset of [-5 * MIN, 0, 30_000]) {
      const info = describeNextRun(
        model({ checks: [check(1)], nextRunAt: iso(offset) }),
        NOW,
      );
      expect(info).toEqual({ state: "due", at: iso(offset) });
      expect(nextRunText(info)).toBe("即将开始");
    }
  });

  it("以后的时间给出相对时间", () => {
    const info = describeNextRun(
      model({ checks: [check(1)], nextRunAt: iso(12 * MIN) }),
      NOW,
    );
    expect(info).toEqual({
      state: "scheduled",
      at: iso(12 * MIN),
      relative: "12 分钟后",
    });
    expect(nextRunText(info)).toBe("12 分钟后");
  });
});

describe("runningCheck", () => {
  it("找出这一轮里正在检测的那条", () => {
    const running = check(2, result({ status: "running" }), result());
    const m = model({
      running: true,
      checks: [check(1, result()), running, check(3)],
    });
    expect(runningCheck(m)).toBe(running);
  });

  it("排队中（一条都没在进行）时是 null", () => {
    expect(
      runningCheck(model({ running: true, checks: [check(1, result())] })),
    ).toBeNull();
    expect(runningCheck(model())).toBeNull();
  });
});

describe("checkMark / pickTab", () => {
  it("页签记号是最近一条记录的状态", () => {
    expect(checkMark(check(1))).toBeNull();
    expect(checkMark(check(1, result({ status: "timeout" })))).toBe("timeout");
  });

  it("选中的页签还在就保留，否则回到第一个", () => {
    const checks = [check(4), check(7)];
    expect(pickTab(checks, "7")).toBe("7");
    expect(pickTab(checks, "9")).toBe("4");
    expect(pickTab(checks, null)).toBe("4");
    expect(pickTab([], "4")).toBeNull();
  });
});

describe("modelProblems", () => {
  it("数各道题最近一次的失败和超时；检测中的看上一次", () => {
    const ok = result();
    expect(modelProblems(model())).toEqual({ error: 0, timeout: 0 });
    expect(modelProblems(model({ checks: [check(1), check(2, ok)] }))).toEqual({
      error: 0,
      timeout: 0,
    });
    expect(
      modelProblems(
        model({
          checks: [
            check(1, result({ status: "timeout" })),
            check(2, result({ status: "error" })),
            check(3, result({ status: "error" })),
            check(4, ok),
          ],
        }),
      ),
    ).toEqual({ error: 2, timeout: 1 });
    // 在跑的那道题看它上一次结束的结果；没有上一次就不算
    expect(
      modelProblems(
        model({
          checks: [
            check(1, result({ status: "running" }), result({ status: "timeout" })),
            check(2, result({ status: "running" })),
            check(3, result({ status: "running" }), ok),
          ],
        }),
      ),
    ).toEqual({ error: 0, timeout: 1 });
  });
});

describe("resolveCheckDisplay", () => {
  it("从没检测过", () => {
    expect(resolveCheckDisplay(check(1))).toEqual({ kind: "never" });
  });

  it("已经结束的最近一次", () => {
    const done = result({ status: "error", error: "HTTP 401：bad key" });
    expect(resolveCheckDisplay(check(1, done))).toEqual({
      kind: "done",
      result: done,
    });
  });

  it("流式检测中显示实时输出", () => {
    const live = result({ status: "running", stream: true, output: "9.9" });
    const prev = result();
    expect(resolveCheckDisplay(check(1, live, prev))).toEqual({
      kind: "live",
      result: live,
    });
  });

  it("非流式检测中显示上一次的结果", () => {
    const running = result({ status: "running", stream: false, output: "" });
    const prev = result();
    expect(resolveCheckDisplay(check(1, running, prev))).toEqual({
      kind: "rerun",
      running,
      result: prev,
    });
    expect(resolveCheckDisplay(check(1, running, null))).toEqual({
      kind: "rerun",
      running,
      result: null,
    });
  });

  it("看的是记录自己的 stream，不是模型现在的设置", () => {
    const running = result({ status: "running", stream: false });
    expect(resolveCheckDisplay({ latest: running, previous: null }).kind).toBe(
      "rerun",
    );
  });
});

describe("resultMeta", () => {
  it("成功的流式记录给出全部信息", () => {
    const r = result();
    expect(resultMeta(r)).toEqual([
      {
        key: "startedAt",
        label: "检测时间",
        value: formatDateTime(r.startedAt),
      },
      { key: "duration", label: "耗时", value: "5.0 秒" },
      { key: "firstToken", label: "首字延迟", value: "800 毫秒" },
      { key: "tokens", label: "输入 / 输出 tokens", value: "20 / 1,234" },
      { key: "finish", label: "结束原因", value: "stop" },
    ]);
  });

  it("非流式不显示首字延迟；缺的字段不显示", () => {
    const r = result({
      stream: false,
      firstTokenMs: 300,
      inputTokens: null,
      outputTokens: null,
      finishReason: "  ",
      durationMs: null,
    });
    expect(resultMeta(r).map((item) => item.key)).toEqual(["startedAt"]);
  });

  it("只有一边的 tokens 时另一边写横线", () => {
    const r = result({ inputTokens: null, outputTokens: 42 });
    expect(resultMeta(r).find((item) => item.key === "tokens")?.value).toBe(
      "— / 42",
    );
  });

  it("检测中不显示耗时（由调用方按时钟算）", () => {
    const r = result({
      status: "running",
      durationMs: null,
      firstTokenMs: null,
    });
    expect(resultMeta(r).map((item) => item.key)).toEqual([
      "startedAt",
      "tokens",
      "finish",
    ]);
  });
});

describe("elapsedText / hasOutput / changedSnapshot", () => {
  it("从开始到现在的时长，不会是负数", () => {
    expect(elapsedText(iso(-12_300), NOW)).toBe("12.3 秒");
    expect(elapsedText(iso(5_000), NOW)).toBe("0 毫秒");
    expect(elapsedText("bad", NOW)).toBe("—");
  });

  it("正文或思考过程有一样不是空白就算有输出", () => {
    expect(hasOutput({ output: " \n", reasoning: "" })).toBe(false);
    expect(hasOutput({ output: "", reasoning: "想一想" })).toBe(true);
    expect(hasOutput({ output: "答", reasoning: "" })).toBe(true);
  });

  it("提示词被改过时返回当时的版本", () => {
    expect(
      changedSnapshot("新题目", result({ promptSnapshot: "旧题目" })),
    ).toBe("旧题目");
    expect(
      changedSnapshot("题目", result({ promptSnapshot: "题目\n" })),
    ).toBeNull();
    expect(changedSnapshot("题目", null)).toBeNull();
  });
});

describe("latestVersion", () => {
  it("id + 状态；从没检测过是 null", () => {
    expect(latestVersion({ id: 70, status: "running" })).toBe("70:running");
    expect(latestVersion({ id: 70, status: "success" })).toBe("70:success");
    expect(latestVersion(null)).toBeNull();
    expect(latestVersion(undefined)).toBeNull();
  });
});

describe("modelPath", () => {
  it("模型详情页的地址，带上提示词就直接打开那道题", () => {
    expect(modelPath(3)).toBe("/models/3");
    expect(modelPath(3, 12)).toBe("/models/3?prompt=12");
  });
});

describe("tocEntries", () => {
  it("渠道一级、模型二级，模型用显示名", () => {
    const a = model({ id: 11, model: "m-1", displayName: "模型一" });
    const b = model({ id: 12, model: "m-2", displayName: "m-2" });
    expect(tocEntries(board([a, b], []))).toEqual([
      { href: "#channel-1", label: "渠道 1", level: 1 },
      { href: "#model-11", label: "模型一", level: 2 },
      { href: "#model-12", label: "m-2", level: 2 },
      { href: "#channel-2", label: "渠道 2", level: 1 },
    ]);
  });
});

describe("formatClock", () => {
  it("本地时间的时:分:秒", () => {
    expect(formatClock(new Date(2026, 9, 11, 8, 5, 3).getTime())).toBe(
      "08:05:03",
    );
    expect(formatClock(Number.NaN)).toBe("—");
  });
});
