import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { ModelInput } from "../shared/types.ts";
import { openDatabase } from "./db.ts";
import type { CompletionRequest, CompletionResult } from "./providers/types.ts";
import { ProviderError } from "./providers/types.ts";
import { Repo, type ChannelCreateData } from "./repo.ts";
import {
  createScheduler,
  RESTART_MESSAGE,
  scrubSecrets,
  STOPPED_MESSAGE,
  type CompleteFn,
  type Scheduler,
  type SchedulerLogger,
} from "./scheduler.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const API_KEY = "sk-secret-abcdef123456";
const BASE_URL = "https://relay.private-host.example:8443/v1";

let db: DatabaseSync;
let repo: Repo;
let clock: Date;
let scheduler: Scheduler | null;

const silent: SchedulerLogger = { info() {}, warn() {}, error() {} };

beforeEach(() => {
  db = openDatabase(":memory:");
  db.exec("DELETE FROM prompts");
  repo = new Repo(db);
  clock = new Date(T0);
  scheduler = null;
});

afterEach(async () => {
  vi.useRealTimers();
  await scheduler?.stop();
  db.close();
});

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function make(complete: CompleteFn): Scheduler {
  scheduler = createScheduler({
    repo,
    complete,
    now: () => clock,
    tickMs: 60_000,
    logger: silent,
  });
  return scheduler;
}

function channel(overrides: Partial<ChannelCreateData> = {}): number {
  return repo.createChannel({
    name: "渠道",
    endpointType: "openai-chat",
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    extraHeaders: {},
    enabled: true,
    sortOrder: 0,
    ...overrides,
  });
}

function prompt(title: string, sortOrder = 0, enabled = true): number {
  return repo.createPrompt({ title, content: `${title}?`, enabled, sortOrder });
}

function model(channelId: number, overrides: Partial<ModelInput> = {}): number {
  return repo.createModel({
    channelId,
    model: "gpt-test",
    displayName: "",
    stream: true,
    timeoutSeconds: 30,
    intervalMinutes: 60,
    maxTokens: null,
    temperature: null,
    enabled: true,
    sortOrder: 0,
    promptIds: [],
    ...overrides,
  });
}

function ok(
  output = "答案",
  extra: Partial<CompletionResult> = {},
): CompletionResult {
  return {
    output,
    reasoning: "",
    inputTokens: 1,
    outputTokens: 2,
    finishReason: "stop",
    ...extra,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 每次调用都挂起，由测试决定什么时候结束 */
function controllable() {
  const calls: {
    request: CompletionRequest;
    done: Deferred<CompletionResult>;
  }[] = [];
  const complete: CompleteFn = (request) => {
    const done = deferred<CompletionResult>();
    calls.push({ request, done });
    request.signal.addEventListener("abort", () => {
      done.reject(new DOMException("This operation was aborted", "AbortError"));
    });
    return done.promise;
  };
  return { calls, complete };
}

function results() {
  return db.prepare("SELECT * FROM results ORDER BY id").all();
}

describe("scrubSecrets", () => {
  const scrub = (text: string, baseUrl: string) =>
    scrubSecrets(text, { apiKey: "", baseUrl, extraHeaders: {} });

  it("替换密钥、请求头的值和整个基础地址，大小写不敏感", () => {
    const text = scrubSecrets(
      `bad key ${API_KEY} at https://RELAY.private-host.example:8443/v1/chat with token-value-xyz`,
      {
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        extraHeaders: { "X-Token": "token-value-xyz" },
      },
    );
    expect(text).toBe("bad key *** at ***/chat with ***");
  });

  it("带点的主机名单独出现时也替换，但不碰更长的名字", () => {
    expect(
      scrub(
        "ENOTFOUND relay.private-host.example; cert for *.RELAY.private-host.example; https://relay.private-host.example:9999/x; relay.private-host.example-mirror.net",
        BASE_URL,
      ),
    ).toBe(
      "ENOTFOUND ***; cert for *.***; https://***:9999/x; relay.private-host.example-mirror.net",
    );
  });

  it("不带点的主机名只在地址里替换，不改坏 API key / api_error", () => {
    expect(
      scrub(
        "Invalid API key provided (type: api_error) at http://api:3000/v1/chat/completions; via //api/x or api:3000",
        "http://api:3000/v1",
      ),
    ).toBe(
      "Invalid API key provided (type: api_error) at ***/chat/completions; via //***/x or ***:3000",
    );
  });

  it("路径里的令牌替换掉，常见的路径段保留", () => {
    expect(
      scrub(
        "HTTP 404：mock upstream: no route for POST /u/acct-7f3a9c2e1b/v1/chat/completions",
        "http://127.0.0.1:4010/u/acct-7f3a9c2e1b/v1",
      ),
    ).toBe(
      "HTTP 404：mock upstream: no route for POST /u/***/v1/chat/completions",
    );
    const generic = "POST /api/paas/v4/chat/completions failed";
    expect(scrub(generic, "https://open.bigmodel.cn/api/paas/v4")).toBe(
      generic,
    );
  });

  it("Cloudflare AI Gateway 地址里的账号 ID 和网关名", () => {
    const account = "0123456789abcdef0123456789abcdef";
    expect(
      scrub(
        `HTTP 401：{"error":"account ${account} has no gateway my-gw"} POST /v1/${account}/my-gw/openai/chat/completions`,
        `https://gateway.ai.cloudflare.com/v1/${account}/my-gw/openai`,
      ),
    ).toBe(
      'HTTP 401：{"error":"account *** has no gateway ***"} POST /v1/***/***/openai/chat/completions',
    );
  });

  it("地址里的用户名和密码（原样的和解码后的）", () => {
    expect(
      scrub(
        "credentials: http://proxyuser:Pr0xy%40Pass@127.0.0.1:4010/v1/chat/completions (user proxyuser, pass Pr0xy@Pass)",
        "http://proxyuser:Pr0xy%40Pass@127.0.0.1:4010/v1",
      ),
    ).toBe("credentials: ***/chat/completions (user ***, pass ***)");
    // 短的用户名只替换完整的词
    expect(
      scrub(
        "auth failed for bob, not bobcat",
        "http://bob:hunter22@relay.example.com/v1",
      ),
    ).toBe("auth failed for ***, not bobcat");
  });

  it("查询串和较长的参数值（如 ?key=）", () => {
    const baseUrl =
      "https://relay.example.com/v1?key=AIzaSyD-secret-key-123&region=us";
    expect(
      scrub(
        "HTTP 400：bad request /v1/chat/completions?key=AIzaSyD-secret-key-123&region=us; API key AIzaSyD-secret-key-123 invalid in us",
        baseUrl,
      ),
    ).toBe(
      "HTTP 400：bad request /v1/chat/completions***; API key *** invalid in us",
    );
  });

  it("短密钥和空的基础地址不替换", () => {
    expect(
      scrubSecrets("key abc api.openai.com", {
        apiKey: "abc",
        baseUrl: "",
        extraHeaders: {},
      }),
    ).toBe("key abc api.openai.com");
  });
});

describe("到期判断", () => {
  it("从没跑过的模型立即到期；之后按 interval 计算", async () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p], intervalMinutes: 60 });
    const complete = vi.fn<CompleteFn>(async () => ok());
    const s = make(complete);

    s.tick();
    await s.idle();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(repo.getModel(m)?.lastRunAt).toBe(T0.toISOString());

    advance(59 * 60_000);
    s.tick();
    await s.idle();
    expect(complete).toHaveBeenCalledTimes(1);

    advance(60_000);
    s.tick();
    await s.idle();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(repo.getModel(m)?.lastRunAt).toBe(
      new Date(T0.getTime() + 3_600_000).toISOString(),
    );
  });

  it("停用的模型 / 渠道、没有启用提示词的模型不会到期", async () => {
    const ch = channel();
    const off = channel({ enabled: false });
    const on = prompt("题");
    const disabled = prompt("停用", 0, false);
    model(ch, { promptIds: [on], enabled: false });
    model(off, { promptIds: [on] });
    model(ch, { promptIds: [disabled] });
    model(ch, { promptIds: [] });
    const complete = vi.fn<CompleteFn>(async () => ok());
    const s = make(complete);
    s.tick();
    await s.idle();
    expect(complete).not.toHaveBeenCalled();
  });

  it("在跑或排队中的模型不会重复进队列", async () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p], intervalMinutes: 1 });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    advance(5 * 60_000);
    s.tick();
    s.tick();
    expect(calls).toHaveLength(1);
    expect(s.isBusy(m)).toBe(true);
    calls[0]!.done.resolve(ok());
    await s.idle();
    expect(s.isBusy(m)).toBe(false);
  });

  it("start() 立即检查一次，stop() 后不再检查", async () => {
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p] });
    const complete = vi.fn<CompleteFn>(async () => ok());
    const s = make(complete);
    s.start();
    await s.idle();
    expect(complete).toHaveBeenCalledTimes(1);
    await s.stop();
    advance(2 * 3_600_000);
    s.tick();
    await s.idle();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("并发与顺序", () => {
  it("同时检测的模型数不超过 max_concurrency，排队的也算 running", async () => {
    repo.updateSettings({ maxConcurrency: 2 });
    const ch = channel();
    const p = prompt("题");
    const ids = [1, 2, 3].map(() => model(ch, { promptIds: [p] }));
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    expect(calls).toHaveLength(2);
    expect(ids.every((id) => s.isBusy(id))).toBe(true);

    calls[0]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[1]!.done.resolve(ok());
    calls[2]!.done.resolve(ok());
    await s.idle();
    expect(results().every((r) => r.status === "success")).toBe(true);
    expect(results()).toHaveLength(3);
  });

  it("每次出队都读最新的 max_concurrency", async () => {
    repo.updateSettings({ maxConcurrency: 1 });
    const ch = channel();
    const p = prompt("题");
    [1, 2, 3].forEach(() => model(ch, { promptIds: [p] }));
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    expect(calls).toHaveLength(1);
    repo.updateSettings({ maxConcurrency: 5 });
    calls[0]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[1]!.done.resolve(ok());
    calls[2]!.done.resolve(ok());
    await s.idle();
  });

  it("同一个模型的提示词按排序值、id 依次检测", async () => {
    const ch = channel();
    const a = prompt("A", 2);
    const b = prompt("B", 1);
    const c = prompt("C", 2);
    model(ch, { promptIds: [a, b, c] });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    expect(calls.map((x) => x.request.prompt)).toEqual(["B?"]);
    calls[0]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.request.prompt).toBe("A?");
    calls[1]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.request.prompt).toBe("C?");
    calls[2]!.done.resolve(ok());
    await s.idle();
    expect(results().map((r) => r.prompt_id)).toEqual([b, a, c]);
  });
});

describe("一次检测的结果", () => {
  it("成功：写入输出、用量、首字延迟、结束原因，检测中能看到实时输出", async () => {
    const ch = channel({ extraHeaders: { "X-A": "1" } });
    const p = prompt("题");
    const m = model(ch, {
      promptIds: [p],
      maxTokens: 50,
      temperature: 0.3,
      stream: true,
    });
    const gate = deferred<void>();
    let seen: CompletionRequest | null = null;
    const s = make(async (request) => {
      seen = request;
      advance(400);
      request.onDelta?.({ reasoning: "" });
      request.onDelta?.({ reasoning: "嗯" });
      advance(100);
      request.onDelta?.({ output: "你好" });
      await gate.promise;
      advance(1500);
      return ok("你好，世界", {
        reasoning: "嗯……",
        inputTokens: 11,
        outputTokens: 22,
        finishReason: "end_turn",
      });
    });
    s.tick();
    await vi.waitFor(() => expect(seen).not.toBeNull());
    expect(seen).toMatchObject({
      endpointType: "openai-chat",
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      extraHeaders: { "X-A": "1" },
      model: "gpt-test",
      prompt: "题?",
      stream: true,
      maxTokens: 50,
      temperature: 0.3,
    });

    const running = results()[0]!;
    expect(running.status).toBe("running");
    expect(running.trigger).toBe("schedule");
    expect(running.prompt_snapshot).toBe("题?");
    expect(s.getLive(Number(running.id))).toEqual({
      output: "你好",
      reasoning: "嗯",
    });
    const board = repo.getBoard(s);
    expect(board.channels[0]!.models[0]!.running).toBe(true);
    expect(board.channels[0]!.models[0]!.checks[0]!.latest).toMatchObject({
      status: "running",
      output: "你好",
      reasoning: "嗯",
    });

    gate.resolve();
    await s.idle();
    const done = repo.getResult(Number(running.id))!;
    expect(done).toMatchObject({
      modelId: m,
      status: "success",
      stream: true,
      output: "你好，世界",
      reasoning: "嗯……",
      error: null,
      startedAt: T0.toISOString(),
      finishedAt: new Date(T0.getTime() + 2000).toISOString(),
      durationMs: 2000,
      firstTokenMs: 400,
      inputTokens: 11,
      outputTokens: 22,
      finishReason: "end_turn",
      trigger: "schedule",
    });
    expect(s.getLive(done.id)).toBeUndefined();
  });

  it("非流式请求没有增量时首字延迟为 null", async () => {
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p], stream: false });
    const s = make(async (request) => {
      expect(request.stream).toBe(false);
      return ok();
    });
    s.tick();
    await s.idle();
    expect(results()[0]).toMatchObject({
      status: "success",
      stream: 0,
      first_token_ms: null,
    });
  });

  it("超时：status=timeout，保存已经收到的部分输出", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p], timeoutSeconds: 5 });
    let aborted = false;
    const s = make(
      (request) =>
        new Promise<CompletionResult>((_, reject) => {
          request.onDelta?.({ output: "写到一半" });
          request.onDelta?.({ reasoning: "想了想" });
          request.signal.addEventListener("abort", () => {
            aborted = true;
            // 中止后迟到的增量不应计入
            request.onDelta?.({ output: "迟到的" });
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    s.tick();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(results()[0]!.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    await s.idle();
    expect(aborted).toBe(true);
    expect(results()[0]).toMatchObject({
      status: "timeout",
      error: "超过 5 秒没有完成",
      output: "写到一半",
      reasoning: "想了想",
    });
  });

  it("上游实现不响应 signal 时也能按时超时", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p], timeoutSeconds: 5 });
    const s = make(() => new Promise<CompletionResult>(() => {}));
    s.tick();
    await vi.advanceTimersByTimeAsync(5_000);
    await s.idle();
    expect(results()[0]).toMatchObject({ status: "timeout", output: "" });
  });

  it("ProviderError：保存错误信息并去掉密钥和主机名", async () => {
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p] });
    const s = make(async (request) => {
      request.onDelta?.({ output: "半截" });
      throw new ProviderError(
        `HTTP 401：key ${API_KEY} rejected by relay.private-host.example`,
        401,
      );
    });
    s.tick();
    await s.idle();
    const row = results()[0]!;
    expect(row).toMatchObject({
      status: "error",
      error: "HTTP 401：key *** rejected by ***",
      output: "半截",
      input_tokens: null,
      finish_reason: null,
    });
    expect(String(row.error)).not.toContain(API_KEY);
  });

  it("其他错误：出错了：<message>", async () => {
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p] });
    const s = make(async () => {
      throw new TypeError(
        `fetch failed for https://relay.private-host.example:8443`,
      );
    });
    s.tick();
    await s.idle();
    expect(results()[0]).toMatchObject({
      status: "error",
      error: "出错了：fetch failed for https://***:8443",
    });
  });

  it("一条提示词失败不影响同一轮的下一条", async () => {
    const ch = channel();
    const a = prompt("A", 0);
    const b = prompt("B", 1);
    model(ch, { promptIds: [a, b] });
    const s = make(async (request) => {
      if (request.prompt === "A?") throw new ProviderError("坏了");
      return ok();
    });
    s.tick();
    await s.idle();
    expect(results().map((r) => r.status)).toEqual(["error", "success"]);
  });

  it("写完后按 retention_per_check 清理旧记录", async () => {
    repo.updateSettings({ retentionPerCheck: 3 });
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    let n = 0;
    const s = make(async () => ok(`第 ${++n} 次`));
    for (let i = 0; i < 5; i++) {
      expect(s.trigger(m)).toEqual({ queued: true });
      await s.idle();
    }
    expect(results().map((r) => r.output)).toEqual([
      "第 3 次",
      "第 4 次",
      "第 5 次",
    ]);
  });
});

describe("手动触发", () => {
  it("可以只测一条提示词，trigger=manual，并更新 last_run_at", async () => {
    const ch = channel();
    const a = prompt("A", 0);
    const b = prompt("B", 1);
    const m = model(ch, { promptIds: [a, b] });
    const complete = vi.fn<CompleteFn>(async () => ok());
    const s = make(complete);
    advance(1234);
    expect(s.trigger(m, b)).toEqual({ queued: true });
    await s.idle();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0].prompt).toBe("B?");
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ prompt_id: b, trigger: "manual" });
    expect(repo.getModel(m)?.lastRunAt).toBe(
      new Date(T0.getTime() + 1234).toISOString(),
    );
  });

  it("已经在跑或排队时返回 queued: false", async () => {
    repo.updateSettings({ maxConcurrency: 1 });
    const ch = channel();
    const p = prompt("题");
    const running = model(ch, { promptIds: [p] });
    const waiting = model(ch, { promptIds: [p] });
    const { calls, complete } = controllable();
    const s = make(complete);
    expect(s.trigger(running)).toEqual({ queued: true });
    expect(s.trigger(waiting)).toEqual({ queued: true });
    expect(s.trigger(running)).toEqual({ queued: false });
    expect(s.trigger(waiting)).toEqual({ queued: false });
    expect(calls).toHaveLength(1);
    calls[0]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.done.resolve(ok());
    await s.idle();
  });

  it("排在队首", async () => {
    repo.updateSettings({ maxConcurrency: 1 });
    const ch = channel();
    const p = prompt("题");
    const first = model(ch, { promptIds: [p], model: "first" });
    model(ch, { promptIds: [p], model: "second" });
    const manual = model(ch, {
      promptIds: [p],
      model: "manual",
      enabled: false,
    });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    expect(calls.map((c) => c.request.model)).toEqual(["first"]);
    expect(s.trigger(manual)).toEqual({ queued: true });
    calls[0]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // 手动触发的（即使模型停用）排在定时排队的前面
    expect(calls[1]!.request.model).toBe("manual");
    calls[1]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.done.resolve(ok());
    await s.idle();
    expect(repo.getModel(first)?.lastRunAt).not.toBeNull();
  });

  it("排队期间被停用的模型不再定时检测", async () => {
    repo.updateSettings({ maxConcurrency: 1 });
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p], model: "a" });
    const b = model(ch, { promptIds: [p], model: "b" });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(b);
    calls[0]!.done.resolve(ok());
    await s.idle();
    expect(calls).toHaveLength(1);
    expect(repo.getModel(b)?.lastRunAt).toBeNull();
  });
});

describe("中止", () => {
  it("stop() 中止进行中的检测并记为 error，清空队列", async () => {
    repo.updateSettings({ maxConcurrency: 1 });
    const ch = channel();
    const p = prompt("题");
    const q = prompt("题2", 1);
    const m = model(ch, { promptIds: [p, q] });
    const queued = model(ch, { promptIds: [p] });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    calls[0]!.request.onDelta?.({ output: "一半" });
    expect(s.isBusy(queued)).toBe(true);
    await s.stop();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.signal.aborted).toBe(true);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({
      model_id: m,
      status: "error",
      error: STOPPED_MESSAGE,
      output: "一半",
    });
    expect(s.isBusy(queued)).toBe(false);
    expect(s.trigger(queued)).toEqual({ queued: false });
  });

  it("stop() 打断的模型清空上次检测时间，下次启动后第一次检查就重测", async () => {
    const ch = channel();
    const p = prompt("题");
    const q = prompt("题2", 1);
    const a = model(ch, { promptIds: [p, q], model: "a" });
    const b = model(ch, { promptIds: [p], model: "b" });
    const first = controllable();
    const s = make(first.complete);
    s.tick();
    expect(first.calls.map((c) => c.request.model)).toEqual(["a", "b"]);
    first.calls[1]!.done.resolve(ok());
    await vi.waitFor(() => expect(s.isBusy(b)).toBe(false));
    await s.stop();
    // a 这一轮没跑完，b 已经跑完了
    expect(repo.getModel(a)?.lastRunAt).toBeNull();
    expect(repo.getModel(b)?.lastRunAt).toBe(T0.toISOString());

    advance(60_000);
    const complete = vi.fn<CompleteFn>(async () => ok());
    const restarted = make(complete);
    restarted.tick();
    await restarted.idle();
    expect(complete.mock.calls.map(([r]) => [r.model, r.prompt])).toEqual([
      ["a", "题?"],
      ["a", "题2?"],
    ]);
  });

  it("删除模型时中止它正在进行的检测，这一轮不再继续", async () => {
    const ch = channel();
    const p = prompt("题");
    const q = prompt("题2", 1);
    const m = model(ch, { promptIds: [p, q] });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    expect(calls).toHaveLength(1);
    s.cancelModel(m);
    repo.deleteModel(m);
    await s.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.signal.aborted).toBe(true);
    expect(results()).toHaveLength(0);
    expect(s.isBusy(m)).toBe(false);
  });

  it("删除模型时也移出队列", async () => {
    repo.updateSettings({ maxConcurrency: 1 });
    const ch = channel();
    const p = prompt("题");
    model(ch, { promptIds: [p] });
    const queued = model(ch, { promptIds: [p] });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    s.cancelModel(queued);
    expect(s.isBusy(queued)).toBe(false);
    repo.deleteModel(queued);
    calls[0]!.done.resolve(ok());
    await s.idle();
    expect(calls).toHaveLength(1);
  });

  it("删除提示词只中止正在检测它的请求，这一轮继续下一条", async () => {
    const ch = channel();
    const p = prompt("题", 0);
    const q = prompt("题2", 1);
    model(ch, { promptIds: [p, q] });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    s.cancelPrompt(p);
    repo.deletePrompt(p);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.request.signal.aborted).toBe(true);
    expect(calls[1]!.request.prompt).toBe("题2?");
    calls[1]!.done.resolve(ok());
    await s.idle();
    expect(results().map((r) => [r.prompt_id, r.status])).toEqual([
      [q, "success"],
    ]);
  });

  it("模型被停用时让正在进行的这一轮跑完", async () => {
    const ch = channel();
    const p = prompt("题", 0);
    const q = prompt("题2", 1);
    const m = model(ch, { promptIds: [p, q] });
    const { calls, complete } = controllable();
    const s = make(complete);
    s.tick();
    db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(m);
    calls[0]!.done.resolve(ok());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.done.resolve(ok());
    await s.idle();
    expect(results().map((r) => r.status)).toEqual(["success", "success"]);
  });
});

describe("启动恢复", () => {
  it("残留的 running 记录改为 error", () => {
    const ch = channel();
    const p = prompt("题");
    const m = model(ch, { promptIds: [p] });
    const id = repo.insertRunningResult({
      modelId: m,
      promptId: p,
      promptSnapshot: "x",
      stream: true,
      startedAt: T0.toISOString(),
      trigger: "schedule",
    });
    expect(repo.recoverStaleRunning(RESTART_MESSAGE)).toBe(1);
    expect(repo.getResult(id)).toMatchObject({
      status: "error",
      error: RESTART_MESSAGE,
    });
    expect(repo.getResult(id)?.finishedAt).not.toBeNull();
  });

  it("被打断的模型启动后第一次检查就重测，其它模型照常按间隔", async () => {
    const ch = channel();
    const p = prompt("题");
    const interrupted = model(ch, { promptIds: [p], model: "a" });
    const finished = model(ch, { promptIds: [p], model: "b" });
    repo.setLastRunAt(interrupted, T0.toISOString());
    repo.setLastRunAt(finished, T0.toISOString());
    repo.insertRunningResult({
      modelId: interrupted,
      promptId: p,
      promptSnapshot: "x",
      stream: true,
      startedAt: T0.toISOString(),
      trigger: "schedule",
    });
    expect(repo.recoverStaleRunning(RESTART_MESSAGE)).toBe(1);
    expect(repo.getModel(interrupted)?.lastRunAt).toBeNull();
    expect(repo.getModel(finished)?.lastRunAt).toBe(T0.toISOString());

    advance(60_000);
    const complete = vi.fn<CompleteFn>(async () => ok());
    const s = make(complete);
    s.tick();
    await s.idle();
    expect(complete.mock.calls.map(([r]) => r.model)).toEqual(["a"]);
  });
});
