import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type {
  BoardResponse,
  HistoryResponse,
  ModelInput,
  ResultDetail,
} from "../../shared/types.ts";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { Repo, type ChannelCreateData, type RuntimeView } from "../repo.ts";
import type { SchedulerControl } from "../scheduler.ts";
import { DEV_NOTICE } from "../static.ts";

const SECRET_KEY = "sk-live-0123456789abcdef";
const SECRET_HOST = "hidden-relay.internal.example";
const SECRET_HEADER = "header-token-987654";

let db: DatabaseSync;
let repo: Repo;
let runtime: RuntimeView;

function fakeScheduler(): SchedulerControl {
  return {
    trigger: () => ({ queued: false }),
    cancelModel: () => {},
    cancelPrompt: () => {},
    isBusy: (id) => runtime.isBusy(id),
    getLive: (id) => runtime.getLive(id),
  };
}

function makeApp(staticDir: string | null = null) {
  return createApp({
    repo,
    scheduler: fakeScheduler(),
    config: {
      adminUsername: "admin",
      adminPassword: "password",
      sessionSecret: "s".repeat(64),
      trustProxy: false,
    },
    listModels: async () => [],
    staticDir,
    onError: (err) => {
      throw err;
    },
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  db.exec("DELETE FROM prompts");
  repo = new Repo(db);
  runtime = { isBusy: () => false, getLive: () => undefined };
});

afterEach(() => {
  db.close();
});

function channel(overrides: Partial<ChannelCreateData> = {}): number {
  return repo.createChannel({
    name: "渠道",
    endpointType: "anthropic",
    baseUrl: `https://${SECRET_HOST}/api`,
    apiKey: SECRET_KEY,
    extraHeaders: { "X-Relay-Token": SECRET_HEADER },
    enabled: true,
    sortOrder: 0,
    ...overrides,
  });
}

function prompt(title: string, enabled = true): number {
  return repo.createPrompt({
    title,
    content: `${title}内容`,
    enabled,
    sortOrder: 0,
  });
}

function model(channelId: number, overrides: Partial<ModelInput> = {}): number {
  return repo.createModel({
    channelId,
    model: "claude-test",
    displayName: "",
    stream: true,
    timeoutSeconds: 60,
    intervalMinutes: 60,
    maxTokens: null,
    temperature: null,
    enabled: true,
    sortOrder: 0,
    promptIds: [],
    ...overrides,
  });
}

function result(
  modelId: number,
  promptId: number,
  status: "running" | "success" | "error" = "success",
) {
  const id = repo.insertRunningResult({
    modelId,
    promptId,
    promptSnapshot: "快照",
    stream: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    trigger: "schedule",
  });
  if (status !== "running") {
    repo.finishResult(id, {
      status,
      output: status === "error" ? "" : `结果 ${id}`,
      reasoning: "",
      error: status === "error" ? "HTTP 500：上游出错" : null,
      finishedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 5000,
      firstTokenMs: 100,
      inputTokens: 3,
      outputTokens: 4,
      finishReason: "end_turn",
    });
  }
  return id;
}

async function get(
  app: ReturnType<typeof makeApp>,
  path: string,
  init?: RequestInit,
) {
  const res = await app.request(`http://localhost${path}`, init);
  return res;
}

describe("GET /api/public/board", () => {
  it("返回看板，合并实时输出，并且不含任何密钥 / 地址 / 请求头", async () => {
    const ch = channel({ name: "Anthropic 官方" });
    channel({ name: "停用的", enabled: false });
    const p = prompt("题");
    const m = model(ch, { displayName: "Claude", promptIds: [p] });
    const done = result(m, p);
    const running = result(m, p, "running");
    runtime = {
      isBusy: (id) => id === m,
      getLive: (id) =>
        id === running ? { output: "正在写", reasoning: "" } : undefined,
    };
    const app = makeApp();
    const res = await get(app, "/api/public/board");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const text = await res.text();
    for (const secret of [
      SECRET_KEY,
      SECRET_HOST,
      SECRET_HEADER,
      "X-Relay-Token",
      "apiKey",
      "baseUrl",
      "extraHeaders",
    ]) {
      expect(text).not.toContain(secret);
    }
    const board = JSON.parse(text) as BoardResponse;
    expect(board.channels.map((c) => c.name)).toEqual(["Anthropic 官方"]);
    expect(board.channels[0]!.endpointType).toBe("anthropic");
    const bm = board.channels[0]!.models[0]!;
    expect(bm).toMatchObject({
      id: m,
      displayName: "Claude",
      model: "claude-test",
      running: true,
    });
    expect(bm.checks[0]!.latest).toMatchObject({
      id: running,
      status: "running",
      output: "正在写",
    });
    expect(bm.checks[0]!.previous).toMatchObject({
      id: done,
      status: "success",
    });
  });
});

describe("GET /api/public/history", () => {
  it("按 id 倒序，limit 默认 20、最大 100", async () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    const ids = Array.from({ length: 25 }, () => result(m, p));
    const app = makeApp();
    const res = await get(
      app,
      `/api/public/history?modelId=${m}&promptId=${p}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryResponse;
    expect(body.items).toHaveLength(20);
    expect(body.items[0]).toEqual({
      id: ids[24],
      status: "success",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 5000,
      trigger: "schedule",
    });
    const limited = (await (
      await get(app, `/api/public/history?modelId=${m}&promptId=${p}&limit=3`)
    ).json()) as HistoryResponse;
    expect(limited.items.map((i) => i.id)).toEqual([ids[24], ids[23], ids[22]]);
    const big = (await (
      await get(app, `/api/public/history?modelId=${m}&promptId=${p}&limit=500`)
    ).json()) as HistoryResponse;
    expect(big.items).toHaveLength(25);
    expect(big.hasMore).toBe(false);
  });

  it("before 翻页：只给更早的记录，hasMore 说明后面还有没有", async () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    const ids = Array.from({ length: 7 }, () => result(m, p));
    const app = makeApp();
    const page = async (query: string) =>
      (await (
        await get(app, `/api/public/history?modelId=${m}&promptId=${p}${query}`)
      ).json()) as HistoryResponse;

    const first = await page("&limit=3");
    expect(first.items.map((i) => i.id)).toEqual([ids[6], ids[5], ids[4]]);
    expect(first.hasMore).toBe(true);
    const second = await page(`&limit=3&before=${ids[4]}`);
    expect(second.items.map((i) => i.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(second.hasMore).toBe(true);
    const last = await page(`&limit=3&before=${ids[1]}`);
    expect(last.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(last.hasMore).toBe(false);
    // 刚好取完时也不说还有
    expect((await page("&limit=7")).hasMore).toBe(false);
    expect((await page(`&before=${ids[0]}`)).items).toEqual([]);

    for (const bad of ["0", "-1", "x", "1.5"]) {
      const res = await get(
        app,
        `/api/public/history?modelId=${m}&promptId=${p}&before=${bad}`,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "before 必须是正整数" });
    }
  });

  it("参数不对 400；模型或渠道停用 / 不存在、提示词停用时 404", async () => {
    const ch = channel();
    const off = channel({ enabled: false });
    const p = prompt("题");
    const hiddenPrompt = prompt("停用题", false);
    const visible = model(ch, { promptIds: [p, hiddenPrompt] });
    const disabled = model(ch, { enabled: false, promptIds: [p] });
    const inOff = model(off, { promptIds: [p] });
    const app = makeApp();
    expect(
      (await get(app, `/api/public/history?modelId=${visible}`)).status,
    ).toBe(400);
    expect(
      (await get(app, `/api/public/history?modelId=x&promptId=${p}`)).status,
    ).toBe(400);
    expect(
      (
        await get(
          app,
          `/api/public/history?modelId=${visible}&promptId=${p}&limit=0`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await get(app, `/api/public/history?modelId=${visible}&promptId=${p}`))
        .status,
    ).toBe(200);
    for (const [modelId, promptId] of [
      [disabled, p],
      [inOff, p],
      [999, p],
      [visible, hiddenPrompt],
    ]) {
      const res = await get(
        app,
        `/api/public/history?modelId=${modelId}&promptId=${promptId}`,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "不存在" });
    }
  });
});

describe("取消分配的提示词", () => {
  it("历史和记录详情对访客都是 404", async () => {
    const ch = channel();
    const p = prompt("题");
    const q = prompt("另一题");
    const m = model(ch, { promptIds: [p, q] });
    const kept = result(m, p);
    const removed = result(m, q);
    const app = makeApp();
    expect(
      (await get(app, `/api/public/history?modelId=${m}&promptId=${q}`)).status,
    ).toBe(200);
    expect((await get(app, `/api/public/results/${removed}`)).status).toBe(200);

    repo.updateModel(m, {
      channelId: ch,
      model: "claude-test",
      displayName: "",
      stream: true,
      timeoutSeconds: 60,
      intervalMinutes: 60,
      maxTokens: null,
      temperature: null,
      enabled: true,
      sortOrder: 0,
      promptIds: [p],
    });
    const history = await get(
      app,
      `/api/public/history?modelId=${m}&promptId=${q}`,
    );
    expect(history.status).toBe(404);
    expect(await history.json()).toEqual({ error: "不存在" });
    const detail = await get(app, `/api/public/results/${removed}`);
    expect(detail.status).toBe(404);
    expect(await detail.json()).toEqual({ error: "记录不存在" });
    // 仍然分配着的照常可见
    expect((await get(app, `/api/public/results/${kept}`)).status).toBe(200);
    expect(
      (await get(app, `/api/public/history?modelId=${m}&promptId=${p}`)).status,
    ).toBe(200);
  });
});

describe("GET /api/public/results/:id", () => {
  it("返回详情，检测中的用实时输出", async () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    const done = result(m, p, "error");
    const running = result(m, p, "running");
    runtime = {
      isBusy: () => true,
      getLive: (id) =>
        id === running ? { output: "实时", reasoning: "思考" } : undefined,
    };
    const app = makeApp();
    const detail = (await (
      await get(app, `/api/public/results/${done}`)
    ).json()) as ResultDetail;
    expect(detail).toMatchObject({
      id: done,
      status: "error",
      error: "HTTP 500：上游出错",
      modelId: m,
      promptId: p,
    });
    const live = (await (
      await get(app, `/api/public/results/${running}`)
    ).json()) as ResultDetail;
    expect(live).toMatchObject({
      status: "running",
      output: "实时",
      reasoning: "思考",
    });
  });

  it("所属模型不可见或记录不存在时 404", async () => {
    const ch = channel();
    const off = channel({ enabled: false });
    const p = prompt("题");
    const disabled = model(ch, { enabled: false, promptIds: [p] });
    const inOff = model(off, { promptIds: [p] });
    const a = result(disabled, p);
    const b = result(inOff, p);
    const app = makeApp();
    for (const path of [
      `/api/public/results/${a}`,
      `/api/public/results/${b}`,
      "/api/public/results/999",
      "/api/public/results/abc",
    ]) {
      const res = await get(app, path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "记录不存在" });
    }
  });
});

describe("其他 API 行为", () => {
  it("没匹配到的 /api/* 返回 404 JSON", async () => {
    const app = makeApp();
    for (const [method, path] of [
      ["GET", "/api/nope"],
      ["POST", "/api/public/board"],
      ["GET", "/api/public"],
    ] as const) {
      const res = await get(app, path, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "接口不存在" });
    }
  });

  it("未处理的错误返回 500 JSON", async () => {
    const app = createApp({
      repo,
      scheduler: {
        ...fakeScheduler(),
        isBusy: () => {
          throw new Error("boom");
        },
      },
      config: {
        adminUsername: "a",
        adminPassword: "b",
        sessionSecret: "c",
        trustProxy: false,
      },
      onError: () => {},
    });
    model(channel());
    const res = await get(app, "/api/public/board");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "服务器内部错误" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("静态文件", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "amc-static-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(
      join(dir, "index.html"),
      "<!doctype html><title>首页</title>",
    );
    writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
    writeFileSync(join(dir, "favicon.svg"), "<svg></svg>");
    writeFileSync(join(tmpdir(), "amc-outside.txt"), "outside");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(tmpdir(), "amc-outside.txt"), { force: true });
  });

  it("/assets/* 长期缓存，找不到时 404", async () => {
    const app = makeApp(dir);
    const res = await get(app, "/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(await res.text()).toBe("console.log(1)");
    expect((await get(app, "/assets/missing.js")).status).toBe(404);
  });

  it("其余路径找不到文件时回退到 index.html（no-cache，带 X-Frame-Options）", async () => {
    const app = makeApp(dir);
    for (const path of [
      "/",
      "/admin/models",
      "/some/deep/path?x=1",
      "/index.html",
    ]) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("content-security-policy")).toBeNull();
      expect(await res.text()).toContain("首页");
    }
    const icon = await get(app, "/favicon.svg");
    expect(icon.headers.get("content-type")).toMatch(/image\/svg\+xml/);
  });

  it("支持 HEAD 与 ETag", async () => {
    const app = makeApp(dir);
    const head = await get(app, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const etag = head.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const cached = await get(app, "/", { headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);
  });

  it("不能越出目录", async () => {
    const app = makeApp(dir);
    for (const path of [
      "/../amc-outside.txt",
      "/%2e%2e/amc-outside.txt",
      "/assets/..%2f..%2famc-outside.txt",
    ]) {
      const res = await get(app, path);
      expect(await res.text()).not.toBe("outside");
    }
  });

  it("没有构建产物时返回纯文本说明", async () => {
    for (const app of [makeApp(null), makeApp(join(dir, "does-not-exist"))]) {
      const res = await get(app, "/");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/plain/);
      expect(await res.text()).toBe(DEV_NOTICE);
    }
  });

  it("非 GET 的非 API 请求 404", async () => {
    const app = makeApp(dir);
    expect((await get(app, "/", { method: "POST" })).status).toBe(404);
  });
});
