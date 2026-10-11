import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { ModelInput } from "../shared/types.ts";
import { openDatabase } from "./db.ts";
import {
  computeNextRunAt,
  DEFAULT_SETTINGS,
  maskApiKey,
  Repo,
  type ChannelCreateData,
  type FinishedResult,
  type RuntimeView,
} from "./repo.ts";

let db: DatabaseSync;
let repo: Repo;

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = new Repo(db);
  // 去掉预置的示例提示词，让每个用例的 id 从干净的状态开始
  db.exec("DELETE FROM prompts");
});

afterEach(() => {
  db.close();
});

function channel(overrides: Partial<ChannelCreateData> = {}): number {
  return repo.createChannel({
    name: "渠道",
    endpointType: "openai-chat",
    baseUrl: "https://relay.secret-host.example/v1",
    apiKey: "sk-supersecret-0123456789",
    extraHeaders: { "X-Secret": "header-secret-value" },
    enabled: true,
    sortOrder: 0,
    ...overrides,
  });
}

function prompt(
  title: string,
  overrides: { enabled?: boolean; sortOrder?: number; content?: string } = {},
) {
  return repo.createPrompt({
    title,
    content: overrides.content ?? `${title} 的内容`,
    enabled: overrides.enabled ?? true,
    sortOrder: overrides.sortOrder ?? 0,
  });
}

function model(channelId: number, overrides: Partial<ModelInput> = {}): number {
  return repo.createModel({
    channelId,
    model: "gpt-test",
    displayName: "",
    stream: true,
    timeoutSeconds: 60,
    intervalMinutes: 30,
    maxTokens: null,
    temperature: null,
    enabled: true,
    sortOrder: 0,
    promptIds: [],
    ...overrides,
  });
}

function finished(overrides: Partial<FinishedResult> = {}): FinishedResult {
  return {
    status: "success",
    output: "答案",
    reasoning: "",
    error: null,
    finishedAt: "2026-01-01T00:00:10.000Z",
    durationMs: 10_000,
    firstTokenMs: 300,
    inputTokens: 5,
    outputTokens: 7,
    finishReason: "stop",
    ...overrides,
  };
}

function result(
  modelId: number,
  promptId: number,
  status: "running" | FinishedResult["status"] = "success",
  output = "答案",
): number {
  const id = repo.insertRunningResult({
    modelId,
    promptId,
    promptSnapshot: "快照",
    stream: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    trigger: "schedule",
  });
  if (status !== "running") repo.finishResult(id, finished({ status, output }));
  return id;
}

function count(table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}

describe("工具函数", () => {
  it("maskApiKey 按长度打码", () => {
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey("abc")).toBe("••••");
    expect(maskApiKey("12345678")).toBe("••••");
    expect(maskApiKey("sk-abcdef123456")).toBe("sk-a…3456");
  });

  it("computeNextRunAt", () => {
    expect(computeNextRunAt(null, 60, true)).toBeNull();
    expect(computeNextRunAt("2026-01-01T00:00:00.000Z", 60, false)).toBeNull();
    expect(computeNextRunAt("2026-01-01T00:00:00.000Z", 90, true)).toBe(
      "2026-01-01T01:30:00.000Z",
    );
  });
});

describe("设置", () => {
  it("缺省用默认值，修改后读出来是对应的类型", () => {
    expect(repo.getSettings()).toEqual(DEFAULT_SETTINGS);
    const updated = repo.updateSettings({
      siteTitle: "新标题",
      maxConcurrency: 5,
    });
    expect(updated).toEqual({
      ...DEFAULT_SETTINGS,
      siteTitle: "新标题",
      maxConcurrency: 5,
    });
    expect(repo.getSettings().maxConcurrency).toBe(5);
  });

  it("库里存了不合法的值时退回默认值", () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('max_concurrency', 'abc')",
    ).run();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('retention_per_check', '0')",
    ).run();
    expect(repo.getSettings().maxConcurrency).toBe(2);
    expect(repo.getSettings().retentionPerCheck).toBe(20);
  });
});

describe("渠道", () => {
  it("增删改查，列表按排序值、id，带模型数和打码的密钥", () => {
    const a = channel({ name: "A", sortOrder: 5 });
    const b = channel({ name: "B", sortOrder: 1, apiKey: "" });
    const c = channel({ name: "C", sortOrder: 5 });
    model(a);
    model(a);
    const list = repo.listAdminChannels();
    expect(list.map((ch) => ch.name)).toEqual(["B", "A", "C"]);
    const first = list.find((ch) => ch.id === a)!;
    expect(first.modelCount).toBe(2);
    expect(first.hasApiKey).toBe(true);
    expect(first.apiKeyMasked).toBe("sk-s…6789");
    expect(first.extraHeaders).toEqual({ "X-Secret": "header-secret-value" });
    expect(JSON.stringify(list)).not.toContain("sk-supersecret-0123456789");
    expect(list.find((ch) => ch.id === b)!.hasApiKey).toBe(false);
    expect(repo.getAdminChannel(c)?.modelCount).toBe(0);
  });

  it("修改时 apiKey：undefined / 空串保留、null 清空、其余替换", () => {
    const id = channel();
    const base = {
      name: "改名",
      endpointType: "anthropic" as const,
      baseUrl: "",
      extraHeaders: {},
      enabled: false,
      sortOrder: 3,
    };
    expect(repo.updateChannel(id, base)).toBe(true);
    expect(repo.getChannel(id)?.apiKey).toBe("sk-supersecret-0123456789");
    expect(repo.getChannel(id)?.name).toBe("改名");
    expect(repo.getChannel(id)?.endpointType).toBe("anthropic");
    expect(repo.getChannel(id)?.enabled).toBe(false);
    repo.updateChannel(id, { ...base, apiKey: "" });
    expect(repo.getChannel(id)?.apiKey).toBe("sk-supersecret-0123456789");
    repo.updateChannel(id, { ...base, apiKey: "new-key-abcdef" });
    expect(repo.getChannel(id)?.apiKey).toBe("new-key-abcdef");
    repo.updateChannel(id, { ...base, apiKey: null });
    expect(repo.getChannel(id)?.apiKey).toBe("");
    expect(repo.updateChannel(9999, base)).toBe(false);
  });

  it("删除渠道级联删除模型、分配关系和记录", () => {
    const ch = channel();
    const other = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    const keep = model(other, { promptIds: [p] });
    result(m, p);
    result(keep, p);
    expect(repo.listModelIdsByChannel(ch)).toEqual([m]);
    expect(repo.deleteChannel(ch)).toBe(true);
    expect(repo.getModel(m)).toBeUndefined();
    expect(count("models")).toBe(1);
    expect(count("model_prompts")).toBe(1);
    expect(count("results")).toBe(1);
    expect(repo.deleteChannel(ch)).toBe(false);
  });
});

describe("提示词", () => {
  it("modelIds 传了整个替换，不传不动", () => {
    const ch = channel();
    const m1 = model(ch);
    const m2 = model(ch);
    const id = repo.createPrompt({
      title: "题",
      content: "内容",
      enabled: true,
      sortOrder: 0,
      modelIds: [m2, m1, m1],
    });
    expect(repo.getAdminPrompt(id)?.modelIds).toEqual([m1, m2]);
    repo.updatePrompt(id, {
      title: "题2",
      content: "内容2",
      enabled: false,
      sortOrder: 1,
      modelIds: [m2],
    });
    expect(repo.getAdminPrompt(id)).toMatchObject({
      title: "题2",
      content: "内容2",
      enabled: false,
      sortOrder: 1,
      modelIds: [m2],
    });
    repo.updatePrompt(id, {
      title: "题3",
      content: "内容3",
      enabled: true,
      sortOrder: 1,
    });
    expect(repo.getAdminPrompt(id)?.modelIds).toEqual([m2]);
    expect(repo.listAdminPrompts().find((p) => p.id === id)?.modelIds).toEqual([
      m2,
    ]);
    expect(
      repo.updatePrompt(9999, {
        title: "x",
        content: "x",
        enabled: true,
        sortOrder: 0,
      }),
    ).toBe(false);
  });

  it("删除提示词级联删除分配关系和记录", () => {
    const ch = channel();
    const p = prompt("题");
    const other = prompt("另一题");
    const m = model(ch, { promptIds: [p, other] });
    result(m, p);
    result(m, other);
    expect(repo.deletePrompt(p)).toBe(true);
    expect(repo.getAdminModel(m)?.promptIds).toEqual([other]);
    expect(count("results")).toBe(1);
  });

  it("missingModelIds / missingPromptIds", () => {
    const ch = channel();
    const m = model(ch);
    const p = prompt("题");
    expect(repo.missingModelIds([m, 999, 999])).toEqual([999]);
    expect(repo.missingPromptIds([p])).toEqual([]);
    expect(repo.missingPromptIds([])).toEqual([]);
  });
});

describe("模型", () => {
  it("增删改查，带渠道名、提示词、状态和下次检测时间", () => {
    const ch = channel({ name: "主渠道" });
    const p1 = prompt("一", { sortOrder: 2 });
    const p2 = prompt("二", { sortOrder: 1 });
    const id = model(ch, {
      model: "claude-x",
      displayName: "Claude",
      promptIds: [p1, p2],
      maxTokens: 100,
      temperature: 0.5,
    });
    let admin = repo.getAdminModel(id)!;
    expect(admin).toMatchObject({
      channelId: ch,
      channelName: "主渠道",
      model: "claude-x",
      displayName: "Claude",
      maxTokens: 100,
      temperature: 0.5,
      promptIds: [p2, p1],
      lastRunAt: null,
      nextRunAt: null,
      running: false,
      lastStatus: null,
    });

    repo.setLastRunAt(id, "2026-01-01T00:00:00.000Z");
    result(id, p1, "error");
    admin = repo.getAdminModel(id, {
      isBusy: () => true,
      getLive: () => undefined,
    })!;
    expect(admin.nextRunAt).toBe("2026-01-01T00:30:00.000Z");
    expect(admin.running).toBe(true);
    expect(admin.lastStatus).toBe("error");

    expect(
      repo.updateModel(id, {
        channelId: ch,
        model: "claude-y",
        displayName: "",
        stream: false,
        timeoutSeconds: 10,
        intervalMinutes: 5,
        maxTokens: null,
        temperature: null,
        enabled: false,
        sortOrder: 9,
        promptIds: [p1],
      }),
    ).toBe(true);
    admin = repo.getAdminModel(id)!;
    expect(admin).toMatchObject({
      model: "claude-y",
      stream: false,
      enabled: false,
      promptIds: [p1],
      maxTokens: null,
    });
    // 停用的模型不会被调度，没有下次检测时间
    expect(admin.nextRunAt).toBeNull();

    expect(repo.deleteModel(id)).toBe(true);
    expect(count("results")).toBe(0);
    expect(count("model_prompts")).toBe(0);
    expect(repo.deleteModel(id)).toBe(false);
  });

  it("listDueCandidates 只含启用、渠道启用、至少有一条启用提示词的模型", () => {
    const ch = channel();
    const off = channel({ enabled: false });
    const on = prompt("启用");
    const disabledPrompt = prompt("停用", { enabled: false });
    const good = model(ch, { promptIds: [on] });
    model(ch, { promptIds: [on], enabled: false });
    model(off, { promptIds: [on] });
    model(ch, { promptIds: [disabledPrompt] });
    model(ch, { promptIds: [] });
    expect(repo.listDueCandidates().map((c) => c.id)).toEqual([good]);
  });

  it("getRunConfig 只带启用的提示词，按排序值、id", () => {
    const ch = channel();
    const a = prompt("a", { sortOrder: 1 });
    const b = prompt("b", { sortOrder: 0 });
    const c = prompt("c", { sortOrder: 1 });
    const d = prompt("d", { enabled: false });
    const m = model(ch, { promptIds: [a, b, c, d] });
    const config = repo.getRunConfig(m)!;
    expect(config.prompts.map((p) => p.id)).toEqual([b, a, c]);
    expect(config.channel.apiKey).toBe("sk-supersecret-0123456789");
    expect(repo.getRunConfig(999)).toBeUndefined();
  });
});

describe("记录", () => {
  it("pruneResults 只保留最近 N 条已结束的，不删 running", () => {
    const ch = channel();
    const p = prompt("题");
    const other = prompt("另一题");
    const m = model(ch, { promptIds: [p, other] });
    const ids = [1, 2, 3, 4, 5].map(() => result(m, p));
    const running = result(m, p, "running");
    const untouched = result(m, other);
    expect(repo.pruneResults(m, p, 2)).toBe(3);
    const left = db
      .prepare("SELECT id FROM results ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(left).toEqual([ids[3], ids[4], running, untouched]);
  });

  it("pruneAllResults 对每个组合分别保留", () => {
    const ch = channel();
    const p = prompt("题");
    const q = prompt("另一题");
    const m = model(ch, { promptIds: [p, q] });
    for (let i = 0; i < 3; i++) {
      result(m, p);
      result(m, q);
    }
    result(m, p, "running");
    expect(repo.pruneAllResults(1)).toBe(4);
    expect(count("results")).toBe(3);
  });

  it("recoverStaleRunning 把残留的 running 改成 error", () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    const running = result(m, p, "running");
    const done = result(m, p);
    expect(
      repo.recoverStaleRunning(
        "服务重启，检测中断",
        "2026-02-02T00:00:00.000Z",
      ),
    ).toBe(1);
    expect(repo.getResult(running)).toMatchObject({
      status: "error",
      error: "服务重启，检测中断",
      finishedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(repo.getResult(done)?.status).toBe("success");
  });

  it("后台记录列表：筛选、分页、按 id 倒序", () => {
    const ch = channel({ name: "渠道甲" });
    const p = prompt("题目甲");
    const m = model(ch, { model: "m-1", displayName: "", promptIds: [p] });
    const ids = [
      result(m, p),
      result(m, p, "error"),
      result(m, p),
      result(m, p, "timeout"),
    ];
    const page1 = repo.listAdminResults({ page: 1, pageSize: 3 });
    expect(page1.total).toBe(4);
    expect(page1.items.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(page1.items[0]).toMatchObject({
      channelName: "渠道甲",
      modelLabel: "m-1",
      promptTitle: "题目甲",
    });
    const page2 = repo.listAdminResults({ page: 2, pageSize: 3 });
    expect(page2.items.map((r) => r.id)).toEqual([ids[0]]);
    const errors = repo.listAdminResults({
      page: 1,
      pageSize: 20,
      status: "error",
      modelId: m,
      promptId: p,
    });
    expect(errors.items.map((r) => r.id)).toEqual([ids[1]]);
    expect(
      repo.listAdminResults({ page: 1, pageSize: 20, modelId: 999 }).total,
    ).toBe(0);
  });

  it("deleteResult / clearResults 跳过 running", () => {
    const ch = channel();
    const p = prompt("题");
    const m1 = model(ch, { promptIds: [p] });
    const m2 = model(ch, { promptIds: [p] });
    const running = result(m1, p, "running");
    const done = result(m1, p);
    result(m2, p);
    expect(repo.deleteResult(running)).toBe("running");
    expect(repo.deleteResult(done)).toBe("deleted");
    expect(repo.deleteResult(done)).toBe("missing");
    result(m1, p);
    expect(repo.clearResults(m1)).toBe(1);
    expect(repo.clearResults()).toBe(1);
    expect(count("results")).toBe(1);
  });

  it("历史记录按 id 倒序并受 limit 限制", () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    const ids = [result(m, p), result(m, p, "error"), result(m, p, "running")];
    const items = repo.listHistory(m, p, 2);
    expect(items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(items[0]).toEqual({
      id: ids[2],
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      durationMs: null,
      trigger: "schedule",
    });
  });
});

describe("前台看板", () => {
  it("只含启用的渠道 / 模型 / 提示词，按排序值、id 排列", () => {
    const later = channel({ name: "后", sortOrder: 2 });
    const first = channel({ name: "先", sortOrder: 1 });
    channel({ name: "停用渠道", sortOrder: 0, enabled: false });
    const empty = channel({ name: "空渠道", sortOrder: 3 });
    const p1 = prompt("题1", { sortOrder: 1 });
    const p2 = prompt("题2", { sortOrder: 0 });
    const off = prompt("停用题", { enabled: false });
    const mB = model(first, {
      model: "b",
      sortOrder: 1,
      promptIds: [p1, p2, off],
    });
    const mA = model(first, {
      model: "a",
      displayName: "模型A",
      sortOrder: 0,
      promptIds: [p1],
    });
    model(first, { model: "off", enabled: false, promptIds: [p1] });
    const mL = model(later, { model: "l", promptIds: [] });

    const board = repo.getBoard();
    expect(board.site).toEqual({
      title: DEFAULT_SETTINGS.siteTitle,
      description: DEFAULT_SETTINGS.siteDescription,
    });
    expect(board.channels.map((c) => c.name)).toEqual(["先", "后", "空渠道"]);
    expect(board.channels.find((c) => c.id === empty)!.models).toEqual([]);
    const firstModels = board.channels[0]!.models;
    expect(firstModels.map((m) => m.id)).toEqual([mA, mB]);
    expect(firstModels[0]!.displayName).toBe("模型A");
    expect(firstModels[1]!.displayName).toBe("b");
    expect(firstModels[1]!.checks.map((c) => c.prompt.title)).toEqual([
      "题2",
      "题1",
    ]);
    expect(firstModels[1]!.checks[0]).toEqual({
      prompt: { id: p2, title: "题2", content: "题2 的内容" },
      latest: null,
      previous: null,
    });
    const lModel = board.channels[1]!.models[0]!;
    expect(lModel.id).toBe(mL);
    expect(lModel.checks).toEqual([]);
  });

  it("latest 是最新一条；running 时 previous 是最近一条已结束的，并合并实时输出", () => {
    const ch = channel();
    const p = prompt("题");
    const q = prompt("另一题");
    const m = model(ch, { promptIds: [p, q], stream: true });
    repo.setLastRunAt(m, "2026-01-01T00:00:00.000Z");
    result(m, p, "success", "旧答案");
    const lastDone = result(m, p, "error", "部分");
    const running = result(m, p, "running");
    const qDone = result(m, q, "success", "q 的答案");

    const runtime: RuntimeView = {
      isBusy: (id) => id === m,
      getLive: (id) =>
        id === running ? { output: "生成中…", reasoning: "想" } : undefined,
    };
    const board = repo.getBoard(runtime, new Date("2026-01-01T00:05:00.000Z"));
    expect(board.generatedAt).toBe("2026-01-01T00:05:00.000Z");
    const bm = board.channels[0]!.models[0]!;
    expect(bm.running).toBe(true);
    expect(bm.lastRunAt).toBe("2026-01-01T00:00:00.000Z");
    expect(bm.nextRunAt).toBe("2026-01-01T00:30:00.000Z");
    const [checkP, checkQ] = bm.checks;
    expect(checkP!.latest).toMatchObject({
      id: running,
      status: "running",
      output: "生成中…",
      reasoning: "想",
    });
    expect(checkP!.previous).toMatchObject({
      id: lastDone,
      status: "error",
      output: "部分",
    });
    expect(checkQ!.latest).toMatchObject({
      id: qDone,
      status: "success",
      output: "q 的答案",
    });
    expect(checkQ!.previous).toBeNull();

    // 没有实时输出时用库里的内容
    const idle = repo.getBoard();
    expect(idle.channels[0]!.models[0]!.checks[0]!.latest?.output).toBe("");
    expect(idle.channels[0]!.models[0]!.running).toBe(false);
  });

  it("已经取消分配的提示词不出现，没有可检测提示词时 nextRunAt 为 null", () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    result(m, p);
    repo.setLastRunAt(m, "2026-01-01T00:00:00.000Z");
    db.prepare("DELETE FROM model_prompts").run();
    const bm = repo.getBoard().channels[0]!.models[0]!;
    expect(bm.checks).toEqual([]);
    expect(bm.nextRunAt).toBeNull();
  });

  it("序列化后不含 API 密钥、基础地址、额外请求头", () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    result(m, p);
    const json = JSON.stringify(repo.getBoard());
    expect(json).not.toContain("sk-supersecret-0123456789");
    expect(json).not.toContain("secret-host");
    expect(json).not.toContain("header-secret-value");
    expect(json).not.toContain("X-Secret");
    expect(json).not.toMatch(/apiKey|baseUrl|extraHeaders/);
  });

  it("可见性：模型和渠道都启用才可见", () => {
    const ch = channel();
    const off = channel({ enabled: false });
    const p = prompt("题");
    const hiddenPrompt = prompt("停用", { enabled: false });
    const visible = model(ch);
    const disabled = model(ch, { enabled: false });
    const inOff = model(off);
    expect(repo.isModelVisible(visible)).toBe(true);
    expect(repo.isModelVisible(disabled)).toBe(false);
    expect(repo.isModelVisible(inOff)).toBe(false);
    expect(repo.isModelVisible(999)).toBe(false);
    expect(repo.isPromptVisible(p)).toBe(true);
    expect(repo.isPromptVisible(hiddenPrompt)).toBe(false);
  });
});
