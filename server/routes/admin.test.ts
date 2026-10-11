import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import type {
  AdminChannel,
  AdminModel,
  AdminPrompt,
  AdminResultsResponse,
  ChannelInput,
  ModelInput,
  ResultDetail,
  Settings,
} from "../../shared/types.ts";
import { createApp } from "../app.ts";
import { createAuth, SESSION_TTL_SECONDS } from "../auth.ts";
import type { AuthConfig } from "../config.ts";
import { openDatabase } from "../db.ts";
import type {
  CompletionResult,
  ListModelsRequest,
} from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import { Repo } from "../repo.ts";
import {
  createScheduler,
  type CompleteFn,
  type Scheduler,
} from "../scheduler.ts";

const CONFIG: AuthConfig = {
  adminUsername: "admin",
  adminPassword: "pa55-word-xyz",
  sessionSecret: "k".repeat(64),
  trustProxy: false,
};

const BASE = "http://localhost";

let db: DatabaseSync;
let repo: Repo;
let scheduler: Scheduler;
let complete: ReturnType<typeof vi.fn<CompleteFn>>;
let listModels: ReturnType<
  typeof vi.fn<(request: ListModelsRequest) => Promise<string[]>>
>;
let app: ReturnType<typeof createApp>;
let cookie: string;
/** complete 挂起直到测试放行 */
let release: () => void;

function gateSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function build(config: AuthConfig = CONFIG) {
  return createApp({
    repo,
    scheduler,
    config,
    listModels,
    staticDir: null,
    onError: (err) => {
      throw err;
    },
  });
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  db.exec("DELETE FROM prompts");
  repo = new Repo(db);
  let gate = gateSignal();
  release = () => {
    gate.resolve();
    gate = gateSignal();
  };
  complete = vi.fn<CompleteFn>(async (): Promise<CompletionResult> => {
    await gate.promise;
    return {
      output: "ok",
      reasoning: "",
      inputTokens: 1,
      outputTokens: 1,
      finishReason: "stop",
    };
  });
  listModels = vi.fn(async () => ["gpt-a", "gpt-b"]);
  scheduler = createScheduler({
    repo,
    complete,
    logger: { info() {}, warn() {}, error() {} },
  });
  app = build();
  cookie = await login();
});

afterEach(async () => {
  release();
  await scheduler.stop();
  db.close();
});

async function login(
  target = app,
  password = CONFIG.adminPassword,
  headers: Record<string, string> = {},
  url = `${BASE}/api/admin/login`,
): Promise<string> {
  const res = await target.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ username: "admin", password }),
  });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = /amc_session=([^;]*)/.exec(header);
  return match ? `amc_session=${match[1]}` : "";
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  options: {
    cookie?: string | null;
    headers?: Record<string, string>;
    raw?: string;
    target?: typeof app;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  const sessionCookieValue =
    options.cookie === undefined ? cookie : options.cookie;
  if (sessionCookieValue) headers.Cookie = sessionCookieValue;
  let payload: string | undefined;
  if (options.raw !== undefined) payload = options.raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await (options.target ?? app).request(`${BASE}${path}`, {
    method,
    headers,
    body: payload,
  });
  const text = await res.text();
  return {
    res,
    status: res.status,
    data: text ? (JSON.parse(text) as unknown) : undefined,
  };
}

function channelInput(overrides: Partial<ChannelInput> = {}): ChannelInput {
  return {
    name: "测试渠道",
    endpointType: "openai-chat",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-abcdefghijkl",
    extraHeaders: { "X-Org": "org-1" },
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

function modelInput(
  channelId: number,
  overrides: Partial<ModelInput> = {},
): ModelInput {
  return {
    channelId,
    model: "gpt-test",
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
  };
}

async function createChannel(
  overrides: Partial<ChannelInput> = {},
): Promise<AdminChannel> {
  const { status, data } = await call(
    "POST",
    "/api/admin/channels",
    channelInput(overrides),
  );
  expect(status).toBe(201);
  return data as AdminChannel;
}

async function createPrompt(
  title = "题",
  modelIds?: number[],
): Promise<AdminPrompt> {
  const { status, data } = await call("POST", "/api/admin/prompts", {
    title,
    content: `${title}的内容`,
    enabled: true,
    sortOrder: 0,
    modelIds,
  });
  expect(status).toBe(201);
  return data as AdminPrompt;
}

async function createModel(
  channelId: number,
  overrides: Partial<ModelInput> = {},
): Promise<AdminModel> {
  const { status, data } = await call(
    "POST",
    "/api/admin/models",
    modelInput(channelId, overrides),
  );
  expect(status).toBe(201);
  return data as AdminModel;
}

describe("认证", () => {
  it("没有会话时 401", async () => {
    for (const [method, path] of [
      ["GET", "/api/admin/me"],
      ["GET", "/api/admin/channels"],
      ["POST", "/api/admin/models/1/run"],
      ["GET", "/api/admin/nope"],
    ] as const) {
      const { status, data } = await call(method, path, undefined, {
        cookie: null,
      });
      expect(status).toBe(401);
      expect(data).toEqual({ error: "未登录或登录已过期" });
    }
  });

  it("登录成功设置 HttpOnly、SameSite=Strict 的 Cookie，之后可以访问", async () => {
    const res = await app.request(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: CONFIG.adminPassword,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "admin" });
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^amc_session=[^;]+/);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
    expect(header).not.toMatch(/Secure/i);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const me = await call("GET", "/api/admin/me", undefined, {
      cookie: sessionCookie(res),
    });
    expect(me.status).toBe(200);
    expect(me.data).toEqual({ username: "admin" });
  });

  it("https 请求的 Cookie 带 Secure；信任代理时看 X-Forwarded-Proto", async () => {
    const httpsRes = await app.request("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: CONFIG.adminPassword,
      }),
    });
    expect(httpsRes.headers.get("set-cookie")).toMatch(/Secure/);

    const proxied = build({ ...CONFIG, trustProxy: true });
    const res = await proxied.request(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({
        username: "admin",
        password: CONFIG.adminPassword,
      }),
    });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);

    // 不信任代理时忽略这个头
    const ignored = await app.request(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({
        username: "admin",
        password: CONFIG.adminPassword,
      }),
    });
    expect(ignored.headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("用户名或密码错误时 401", async () => {
    for (const body of [
      { username: "admin", password: "nope" },
      { username: "root", password: CONFIG.adminPassword },
    ]) {
      const { status, data, res } = await call(
        "POST",
        "/api/admin/login",
        body,
        { cookie: null },
      );
      expect(status).toBe(401);
      expect(data).toEqual({ error: "用户名或密码错误" });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("缺字段时 400", async () => {
    const { status, data } = await call(
      "POST",
      "/api/admin/login",
      { username: "admin" },
      { cookie: null },
    );
    expect(status).toBe(400);
    expect(data).toEqual({ error: "请输入密码" });
  });

  it("失败 10 次后返回 429，正确的密码也不行", async () => {
    const fresh = build();
    for (let i = 0; i < 10; i++) {
      const { status } = await call(
        "POST",
        "/api/admin/login",
        { username: "admin", password: `wrong-${i}` },
        { cookie: null, target: fresh },
      );
      expect(status).toBe(401);
    }
    const blocked = await call(
      "POST",
      "/api/admin/login",
      { username: "admin", password: CONFIG.adminPassword },
      { cookie: null, target: fresh },
    );
    expect(blocked.status).toBe(429);
    expect(blocked.data).toEqual({ error: "登录尝试过多，请 15 分钟后再试" });
  });

  it("同时发来的大量登录请求也最多比对 10 次密码", async () => {
    const fresh = build();
    // 请求头先到、请求体后到时，所有请求都会在任何一次失败被记下之前通过最前面的封禁检查
    const statuses = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const res = await fresh.request(`${BASE}/api/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "admin", password: `burst-${i}` }),
        });
        return res.status;
      }),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
  });

  it("信任代理时按 X-Forwarded-For 最右边（代理追加）的地址限流，左边伪造的不算", async () => {
    const fresh = build({ ...CONFIG, trustProxy: true });
    const attempt = (xff: string, password = "bad") =>
      call(
        "POST",
        "/api/admin/login",
        { username: "admin", password },
        { cookie: null, target: fresh, headers: { "X-Forwarded-For": xff } },
      );
    // 每次换一个伪造的地址：Nginx 的 $proxy_add_x_forwarded_for 会把真实地址追加在最后
    for (let i = 0; i < 10; i++) {
      expect((await attempt(`10.0.${i}.1, 203.0.113.7`)).status).toBe(401);
    }
    const blocked = await attempt("8.8.8.8, 203.0.113.7", CONFIG.adminPassword);
    expect(blocked.status).toBe(429);
    expect((await attempt("203.0.113.7", CONFIG.adminPassword)).status).toBe(
      429,
    );
    // 别的真实地址不受影响
    const other = await attempt(
      "203.0.113.7, 198.51.100.9",
      CONFIG.adminPassword,
    );
    expect(other.status).toBe(200);
  });

  it("TRUST_PROXY=2 时取从右往左第二个；层数不够时退回连接地址", async () => {
    const fresh = build({ ...CONFIG, trustProxy: 2 });
    const attempt = (xff: string, password = "bad") =>
      call(
        "POST",
        "/api/admin/login",
        { username: "admin", password },
        { cookie: null, target: fresh, headers: { "X-Forwarded-For": xff } },
      );
    for (let i = 0; i < 10; i++) {
      await attempt(`spoof-${i}, 198.51.100.1, 10.0.0.${i}`);
    }
    expect(
      (await attempt("198.51.100.1, 10.0.0.99", CONFIG.adminPassword)).status,
    ).toBe(429);
    expect(
      (await attempt("198.51.100.2, 10.0.0.1", CONFIG.adminPassword)).status,
    ).toBe(200);
    // 只有一项时不够两层，按连接地址（测试里没有连接信息，是 "unknown"）计数
    for (let i = 0; i < 10; i++) await attempt(`192.0.2.${i}`);
    expect(
      (
        await call(
          "POST",
          "/api/admin/login",
          { username: "admin", password: CONFIG.adminPassword },
          { cookie: null, target: fresh },
        )
      ).status,
    ).toBe(429);
  });

  it("登录成功后失败次数清零", async () => {
    const fresh = build();
    for (let i = 0; i < 9; i++) {
      await call(
        "POST",
        "/api/admin/login",
        { username: "admin", password: "bad" },
        { cookie: null, target: fresh },
      );
    }
    await login(fresh);
    for (let i = 0; i < 9; i++) {
      await call(
        "POST",
        "/api/admin/login",
        { username: "admin", password: "bad" },
        { cookie: null, target: fresh },
      );
    }
    await login(fresh);
  });

  it("退出登录清掉 Cookie，没有会话也返回 204", async () => {
    const res = await app.request(`${BASE}/api/admin/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(204);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/amc_session=;/);
    expect(header).toMatch(/Max-Age=0/);
    const anonymous = await app.request(`${BASE}/api/admin/logout`, {
      method: "POST",
    });
    expect(anonymous.status).toBe(204);
  });

  it("篡改或过期的令牌被拒绝", async () => {
    const token = cookie.slice("amc_session=".length);
    const [payload, signature] = token.split(".") as [string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ u: "admin", exp: 9_999_999_999 }),
    ).toString("base64url");
    const flipped = `${signature.startsWith("x") ? "y" : "x"}${signature.slice(1)}`;
    for (const bad of [
      `${forgedPayload}.${signature}`,
      `${payload}.${flipped}`,
      "garbage",
    ]) {
      const { status } = await call("GET", "/api/admin/me", undefined, {
        cookie: `amc_session=${bad}`,
      });
      expect(status).toBe(401);
    }
    const auth = createAuth({
      username: CONFIG.adminUsername,
      password: CONFIG.adminPassword,
      secret: CONFIG.sessionSecret,
    });
    const expired = auth.issueToken(
      new Date(Date.now() - (SESSION_TTL_SECONDS + 60) * 1000),
    );
    const { status } = await call("GET", "/api/admin/me", undefined, {
      cookie: `amc_session=${expired}`,
    });
    expect(status).toBe(401);
    const valid = auth.issueToken();
    expect(
      (
        await call("GET", "/api/admin/me", undefined, {
          cookie: `amc_session=${valid}`,
        })
      ).status,
    ).toBe(200);
  });

  it("改了 ADMIN_PASSWORD 后旧会话失效", async () => {
    const changed = build({ ...CONFIG, adminPassword: "another-password" });
    const { status } = await call("GET", "/api/admin/me", undefined, {
      target: changed,
    });
    expect(status).toBe(401);
  });
});

describe("防跨站请求", () => {
  it("Origin 与 Host 不一致的写请求返回 403", async () => {
    const evil = await call("POST", "/api/admin/channels", channelInput(), {
      headers: { Origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(evil.data).toEqual({ error: "跨站请求被拒绝" });
    expect(repo.listAdminChannels()).toHaveLength(0);

    const nullOrigin = await call("DELETE", "/api/admin/results", undefined, {
      headers: { Origin: "null" },
    });
    expect(nullOrigin.status).toBe(403);

    const loginEvil = await call(
      "POST",
      "/api/admin/login",
      { username: "admin", password: CONFIG.adminPassword },
      { cookie: null, headers: { Origin: "https://evil.example" } },
    );
    expect(loginEvil.status).toBe(403);
  });

  it("同源或不带 Origin 的写请求放行，GET 不检查", async () => {
    const same = await call("POST", "/api/admin/channels", channelInput(), {
      headers: { Origin: "http://localhost" },
    });
    expect(same.status).toBe(201);
    const withHost = await call("POST", "/api/admin/channels", channelInput(), {
      headers: {
        Origin: "https://panel.example.com",
        Host: "panel.example.com:443",
      },
    });
    expect(withHost.status).toBe(201);
    const noOrigin = await call("POST", "/api/admin/channels", channelInput());
    expect(noOrigin.status).toBe(201);
    const get = await call("GET", "/api/admin/channels", undefined, {
      headers: { Origin: "https://evil.example" },
    });
    expect(get.status).toBe(200);
  });

  it("反向代理改了 Host：浏览器标明同源就放行，只差端口也放行", async () => {
    const proxied = build({ ...CONFIG, trustProxy: true });
    const loginWith = (headers: Record<string, string>) =>
      call(
        "POST",
        "/api/admin/login",
        { username: "admin", password: CONFIG.adminPassword },
        { cookie: null, target: proxied, headers },
      );
    // Nginx `proxy_set_header Host $host` 丢了外部端口
    expect(
      (
        await loginWith({
          Host: "iq.example.com",
          Origin: "https://iq.example.com:8443",
          "Sec-Fetch-Site": "same-origin",
        })
      ).status,
    ).toBe(200);
    // 只写了 proxy_pass：Host 是内部地址，也没有 X-Forwarded-Host
    expect(
      (
        await loginWith({
          Host: "127.0.0.1:3000",
          Origin: "https://iq.example.com",
          "Sec-Fetch-Site": "same-origin",
        })
      ).status,
    ).toBe(200);
    // 不带 Sec-Fetch-Site（旧浏览器）时只比较主机名，端口不同也算同一个站
    expect(
      (
        await loginWith({
          Host: "iq.example.com",
          Origin: "https://iq.example.com:8443",
        })
      ).status,
    ).toBe(200);
  });

  it("浏览器发了 Sec-Fetch-Site 时只认 same-origin：同一主机的其他端口（same-site）也拒绝", async () => {
    const postPrompt = (title: string, headers: Record<string, string>) =>
      call("POST", "/api/admin/prompts", { title, content: "x" }, { headers });
    // 同一台机器另一个端口上的页面：Origin 主机名和 Host 一样，但浏览器标的是 same-site
    const crossPort = await postPrompt("csrf", {
      Host: "1.2.3.4:3000",
      Origin: "http://1.2.3.4:8080",
      "Sec-Fetch-Site": "same-site",
    });
    expect(crossPort.status).toBe(403);
    expect(crossPort.data).toEqual({ error: "跨站请求被拒绝" });
    // 浏览器标明不是同源时，不管 Origin 写的是什么、带没带都拒绝
    const notSameOrigin: Record<string, string>[] = [
      {
        Host: "1.2.3.4:3000",
        Origin: "http://1.2.3.4:3000",
        "Sec-Fetch-Site": "same-site",
      },
      { Host: "1.2.3.4:3000", "Sec-Fetch-Site": "cross-site" },
      { Host: "1.2.3.4:3000", "Sec-Fetch-Site": "none" },
      { Host: "1.2.3.4:3000", "Sec-Fetch-Site": "" },
    ];
    for (const headers of notSameOrigin) {
      const res = await call("DELETE", "/api/admin/results", undefined, {
        headers,
      });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(repo.listAdminPrompts()).toHaveLength(0);

    const same = await postPrompt("ok", {
      Host: "1.2.3.4:3000",
      Origin: "http://1.2.3.4:3000",
      "Sec-Fetch-Site": "same-origin",
    });
    expect(same.status).toBe(201);
    // 不带 Sec-Fetch-Site（旧浏览器）时退回比较主机名，只差端口放行
    const legacy = await postPrompt("legacy", {
      Host: "1.2.3.4:3000",
      Origin: "http://1.2.3.4:8080",
    });
    expect(legacy.status).toBe(201);
    expect(repo.listAdminPrompts()).toHaveLength(2);
  });

  it("主机名不同的 Origin 仍然拒绝", async () => {
    const proxied = build({ ...CONFIG, trustProxy: true });
    const cases: Record<string, string>[] = [
      { Host: "127.0.0.1:3000", Origin: "https://iq.example.com" },
      {
        Host: "iq.example.com",
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
      {
        Host: "iq.example.com",
        Origin: "https://evil.iq.example.com",
        "Sec-Fetch-Site": "same-site",
      },
    ];
    for (const headers of cases) {
      const res = await call(
        "POST",
        "/api/admin/login",
        { username: "admin", password: CONFIG.adminPassword },
        { cookie: null, target: proxied, headers },
      );
      expect(res.status).toBe(403);
      expect(res.data).toEqual({ error: "跨站请求被拒绝" });
    }
  });
});

describe("渠道", () => {
  it("新建、列表、打码、修改密钥的三种语义、删除", async () => {
    const created = await createChannel();
    expect(created).toMatchObject({
      name: "测试渠道",
      endpointType: "openai-chat",
      baseUrl: "https://relay.example.com/v1",
      hasApiKey: true,
      apiKeyMasked: "sk-a…ijkl",
      extraHeaders: { "X-Org": "org-1" },
      enabled: true,
      sortOrder: 0,
      modelCount: 0,
    });
    expect(created).not.toHaveProperty("apiKey");

    const list = await call("GET", "/api/admin/channels");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).not.toContain("sk-abcdefghijkl");

    const put = (apiKey: string | null | undefined) =>
      call(
        "PUT",
        `/api/admin/channels/${created.id}`,
        channelInput({ name: "改过", apiKey }),
      );

    let res = await put(undefined);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ name: "改过", apiKeyMasked: "sk-a…ijkl" });
    res = await put("");
    expect(res.data).toMatchObject({
      hasApiKey: true,
      apiKeyMasked: "sk-a…ijkl",
    });
    res = await put("  short  ");
    expect(res.data).toMatchObject({ hasApiKey: true, apiKeyMasked: "••••" });
    expect(repo.getChannel(created.id)?.apiKey).toBe("short");
    res = await put(null);
    expect(res.data).toMatchObject({ hasApiKey: false, apiKeyMasked: "" });

    const withoutKey = await call(
      "POST",
      "/api/admin/channels",
      channelInput({ apiKey: undefined }),
    );
    expect(withoutKey.status).toBe(201);
    expect(withoutKey.data).toMatchObject({ hasApiKey: false });

    expect(
      (await call("PUT", "/api/admin/channels/999", channelInput())).status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/admin/channels/${created.id}`)).status,
    ).toBe(204);
    expect(
      (await call("DELETE", `/api/admin/channels/${created.id}`)).status,
    ).toBe(404);
  });

  it("列表按排序值、id", async () => {
    await createChannel({ name: "b", sortOrder: 2 });
    await createChannel({ name: "a", sortOrder: 1 });
    await createChannel({ name: "c", sortOrder: 2 });
    const { data } = await call("GET", "/api/admin/channels");
    expect((data as AdminChannel[]).map((c) => c.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("删除渠道级联删除模型并中止检测", async () => {
    const ch = await createChannel();
    const p = await createPrompt();
    const m = await createModel(ch.id, { promptIds: [p.id] });
    expect(
      (await call("POST", `/api/admin/models/${m.id}/run`, {})).status,
    ).toBe(202);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const signal = complete.mock.calls[0]![0].signal;
    expect((await call("DELETE", `/api/admin/channels/${ch.id}`)).status).toBe(
      204,
    );
    expect(signal.aborted).toBe(true);
    await scheduler.idle();
    expect(repo.getModel(m.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM results").get()?.n).toBe(0);
  });

  it("拉取上游模型列表：成功返回列表，失败 502 带上游信息", async () => {
    const ch = await createChannel();
    const ok = await call(
      "GET",
      `/api/admin/channels/${ch.id}/upstream-models`,
    );
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ models: ["gpt-a", "gpt-b"] });
    expect(listModels).toHaveBeenCalledWith({
      endpointType: "openai-chat",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk-abcdefghijkl",
      extraHeaders: { "X-Org": "org-1" },
    });

    listModels.mockRejectedValueOnce(
      new ProviderError("HTTP 401：Incorrect API key", 401),
    );
    const failed = await call(
      "GET",
      `/api/admin/channels/${ch.id}/upstream-models`,
    );
    expect(failed.status).toBe(502);
    expect(failed.data).toEqual({
      error: "拉取模型列表失败：HTTP 401：Incorrect API key",
    });

    expect(
      (await call("GET", "/api/admin/channels/999/upstream-models")).status,
    ).toBe(404);
  });

  it("校验失败返回 400 和中文信息", async () => {
    const cases: [Partial<ChannelInput> | Record<string, unknown>, string][] = [
      [{ name: "   " }, "名称不能为空"],
      [{ name: "x".repeat(101) }, "名称不能超过 100 个字符"],
      [{ endpointType: "foo" as never }, "端点类型无效"],
      [
        { baseUrl: "ftp://x" },
        "基础地址必须是 http:// 或 https:// 开头的有效地址",
      ],
      [
        { baseUrl: "not a url" },
        "基础地址必须是 http:// 或 https:// 开头的有效地址",
      ],
      [{ apiKey: "k".repeat(1001) }, "API 密钥不能超过 1000 个字符"],
      [
        { extraHeaders: { "Bad Header": "x" } },
        '请求头名称"Bad Header"含有不允许的字符',
      ],
      [{ extraHeaders: { "X-A": "a\r\nb" } }, '请求头"X-A"的值不能包含换行'],
      [{ extraHeaders: { "X-A": "1", "x-a": "2" } }, '请求头"x-a"重复了'],
      [
        {
          extraHeaders: Object.fromEntries(
            Array.from({ length: 31 }, (_, i) => [`X-${i}`, "v"]),
          ),
        },
        "额外请求头最多 30 个",
      ],
      [
        { extraHeaders: [] as never },
        "额外请求头必须是 { 名称: 值 } 形式的对象",
      ],
      [{ sortOrder: 1.5 }, "排序值必须是 -1000000 到 1000000 之间的整数"],
      [{ enabled: "yes" as never }, "启用必须是 true 或 false"],
    ];
    for (const [overrides, message] of cases) {
      const { status, data } = await call("POST", "/api/admin/channels", {
        ...channelInput(),
        ...overrides,
      });
      expect(status, message).toBe(400);
      expect(data).toEqual({ error: message });
    }
    const invalidJson = await call("POST", "/api/admin/channels", undefined, {
      raw: "{bad",
    });
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.data).toEqual({ error: "请求体不是合法的 JSON" });
    const notObject = await call("POST", "/api/admin/channels", [1, 2]);
    expect(notObject.data).toEqual({ error: "请求体必须是 JSON 对象" });
  });

  it("字符串字段去首尾空白", async () => {
    const created = await createChannel({
      name: "  渠道  ",
      baseUrl: "  https://a.example.com  ",
      extraHeaders: { " X-K ": "  v  " },
    });
    expect(created).toMatchObject({
      name: "渠道",
      baseUrl: "https://a.example.com",
      extraHeaders: { "X-K": "v" },
    });
  });
});

describe("提示词", () => {
  it("modelIds 整个替换、不传不动、不存在的 id 返回 400", async () => {
    const ch = await createChannel();
    const m1 = await createModel(ch.id);
    const m2 = await createModel(ch.id);
    const created = await createPrompt("题", [m1.id, m2.id]);
    expect(created.modelIds).toEqual([m1.id, m2.id]);

    const update = (body: Record<string, unknown>) =>
      call("PUT", `/api/admin/prompts/${created.id}`, {
        title: "题",
        content: "内容",
        enabled: true,
        sortOrder: 0,
        ...body,
      });
    expect((await update({ modelIds: [m2.id] })).data).toMatchObject({
      modelIds: [m2.id],
    });
    expect((await update({})).data).toMatchObject({ modelIds: [m2.id] });
    const missing = await update({ modelIds: [m1.id, 999] });
    expect(missing.status).toBe(400);
    expect(missing.data).toEqual({ error: "模型不存在：#999" });
    expect(repo.getAdminPrompt(created.id)?.modelIds).toEqual([m2.id]);

    const list = await call("GET", "/api/admin/prompts");
    expect(list.data).toEqual([
      expect.objectContaining({ id: created.id, modelIds: [m2.id] }),
    ]);
  });

  it("内容保留原样，只判断非空白；校验信息", async () => {
    const res = await call("POST", "/api/admin/prompts", {
      title: " 标题 ",
      content: "  第一行\n  第二行  ",
      enabled: true,
      sortOrder: 0,
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      title: "标题",
      content: "  第一行\n  第二行  ",
      modelIds: [],
    });

    for (const [body, message] of [
      [{ title: "t", content: " \n " }, "内容不能为空"],
      [{ title: "", content: "x" }, "标题不能为空"],
      [{ title: "t", content: "x".repeat(20001) }, "内容不能超过 20000 个字符"],
      [{ title: "t", content: "x", modelIds: [0] }, "模型 id 必须是正整数"],
    ] as const) {
      const r = await call("POST", "/api/admin/prompts", body);
      expect(r.status).toBe(400);
      expect(r.data).toEqual({ error: message });
    }
  });

  it("删除提示词级联删除分配关系", async () => {
    const ch = await createChannel();
    const p = await createPrompt();
    const m = await createModel(ch.id, { promptIds: [p.id] });
    expect((await call("DELETE", `/api/admin/prompts/${p.id}`)).status).toBe(
      204,
    );
    expect(repo.getAdminModel(m.id)?.promptIds).toEqual([]);
    expect((await call("DELETE", `/api/admin/prompts/${p.id}`)).status).toBe(
      404,
    );
  });
});

describe("模型", () => {
  it("新建、修改、删除；渠道 / 提示词必须存在", async () => {
    const ch = await createChannel({ name: "主" });
    const p = await createPrompt();
    const created = await createModel(ch.id, {
      model: "  claude-x  ",
      displayName: "Claude",
      promptIds: [p.id],
      maxTokens: 1000,
      temperature: 1.2,
    });
    expect(created).toMatchObject({
      channelId: ch.id,
      channelName: "主",
      model: "claude-x",
      displayName: "Claude",
      promptIds: [p.id],
      maxTokens: 1000,
      temperature: 1.2,
      running: false,
      lastStatus: null,
      lastRunAt: null,
      nextRunAt: null,
    });

    const noChannel = await call("POST", "/api/admin/models", modelInput(999));
    expect(noChannel.status).toBe(400);
    expect(noChannel.data).toEqual({ error: "渠道不存在" });
    const noPrompt = await call(
      "POST",
      "/api/admin/models",
      modelInput(ch.id, { promptIds: [p.id, 77] }),
    );
    expect(noPrompt.status).toBe(400);
    expect(noPrompt.data).toEqual({ error: "提示词不存在：#77" });

    const updated = await call(
      "PUT",
      `/api/admin/models/${created.id}`,
      modelInput(ch.id, { stream: false, promptIds: [] }),
    );
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({
      stream: false,
      promptIds: [],
      model: "gpt-test",
    });
    expect(
      (await call("PUT", "/api/admin/models/999", modelInput(ch.id))).status,
    ).toBe(404);

    const list = await call("GET", "/api/admin/models");
    expect((list.data as AdminModel[]).map((m) => m.id)).toEqual([created.id]);

    expect(
      (await call("DELETE", `/api/admin/models/${created.id}`)).status,
    ).toBe(204);
    expect(
      (await call("DELETE", `/api/admin/models/${created.id}`)).status,
    ).toBe(404);
    expect((await call("DELETE", "/api/admin/models/abc")).status).toBe(404);
  });

  it("校验失败返回 400 和中文信息", async () => {
    const ch = await createChannel();
    const cases: [Partial<ModelInput>, string][] = [
      [{ model: "  " }, "模型 ID 不能为空"],
      [{ model: "m".repeat(201) }, "模型 ID 不能超过 200 个字符"],
      [{ displayName: "d".repeat(101) }, "显示名不能超过 100 个字符"],
      [{ timeoutSeconds: 4 }, "超时时间必须是 5 到 3600 之间的整数"],
      [{ timeoutSeconds: 3601 }, "超时时间必须是 5 到 3600 之间的整数"],
      [{ timeoutSeconds: 10.5 }, "超时时间必须是 5 到 3600 之间的整数"],
      [{ intervalMinutes: 0 }, "检测间隔必须是 1 到 10080 之间的整数"],
      [{ intervalMinutes: 10081 }, "检测间隔必须是 1 到 10080 之间的整数"],
      [{ maxTokens: 0 }, "最大输出 tokens 必须是 1 到 1000000 之间的整数"],
      [{ temperature: 2.1 }, "温度必须是 0 到 2 之间的数字"],
      [{ temperature: -0.1 }, "温度必须是 0 到 2 之间的数字"],
      [{ stream: "true" as never }, "流式必须是 true 或 false"],
      [{ channelId: "1" as never }, "请选择渠道"],
    ];
    for (const [overrides, message] of cases) {
      const { status, data } = await call(
        "POST",
        "/api/admin/models",
        modelInput(ch.id, overrides),
      );
      expect(status, message).toBe(400);
      expect(data).toEqual({ error: message });
    }
  });

  it("立即检测：202 queued true，已在跑时 200 queued false", async () => {
    const ch = await createChannel();
    const a = await createPrompt("A");
    const b = await createPrompt("B");
    const off = await createPrompt("停用");
    await call("PUT", `/api/admin/prompts/${off.id}`, {
      title: "停用",
      content: "x",
      enabled: false,
      sortOrder: 0,
    });
    const m = await createModel(ch.id, { promptIds: [a.id, b.id, off.id] });
    const bare = await createModel(ch.id);

    const notAssigned = await call("POST", `/api/admin/models/${m.id}/run`, {
      promptId: off.id,
    });
    expect(notAssigned.status).toBe(400);
    const noPrompts = await call(
      "POST",
      `/api/admin/models/${bare.id}/run`,
      {},
    );
    expect(noPrompts.status).toBe(400);
    expect(noPrompts.data).toEqual({ error: "这个模型还没有分配启用的提示词" });
    expect((await call("POST", "/api/admin/models/999/run", {})).status).toBe(
      404,
    );

    const first = await call("POST", `/api/admin/models/${m.id}/run`, {
      promptId: b.id,
    });
    expect(first.status).toBe(202);
    expect(first.data).toEqual({ queued: true });
    const again = await call("POST", `/api/admin/models/${m.id}/run`);
    expect(again.status).toBe(200);
    expect(again.data).toEqual({ queued: false });

    const busy = await call("GET", "/api/admin/models");
    expect(
      (busy.data as AdminModel[]).find((x) => x.id === m.id)?.running,
    ).toBe(true);

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    release();
    await scheduler.idle();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0].prompt).toBe("B的内容");
    const after = await call("GET", "/api/admin/models");
    expect(
      (after.data as AdminModel[]).find((x) => x.id === m.id),
    ).toMatchObject({
      running: false,
      lastStatus: "success",
    });
  });
});

describe("检测记录", () => {
  async function seed() {
    const ch = await createChannel({ name: "渠道X" });
    const p = await createPrompt("题X");
    const m = await createModel(ch.id, { model: "mx", promptIds: [p.id] });
    const insert = (status: "running" | "success" | "error") => {
      const id = repo.insertRunningResult({
        modelId: m.id,
        promptId: p.id,
        promptSnapshot: "快照",
        stream: true,
        startedAt: new Date().toISOString(),
        trigger: "manual",
      });
      if (status !== "running") {
        repo.finishResult(id, {
          status,
          output: "out",
          reasoning: "",
          error: status === "error" ? "坏了" : null,
          finishedAt: new Date().toISOString(),
          durationMs: 5,
          firstTokenMs: 1,
          inputTokens: 2,
          outputTokens: 3,
          finishReason: "stop",
        });
      }
      return id;
    };
    return { m, p, insert };
  }

  it("列表、筛选、分页", async () => {
    const { m, p, insert } = await seed();
    const ids = [
      insert("success"),
      insert("error"),
      insert("success"),
      insert("running"),
    ];
    const all = await call("GET", "/api/admin/results?pageSize=2");
    const data = all.data as AdminResultsResponse;
    expect(data).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(data.items.map((r) => r.id)).toEqual([ids[3], ids[2]]);
    expect(data.items[0]).toMatchObject({
      modelId: m.id,
      promptId: p.id,
      channelName: "渠道X",
      modelLabel: "mx",
      promptTitle: "题X",
      trigger: "manual",
    });
    const page2 = (await call("GET", "/api/admin/results?pageSize=2&page=2"))
      .data as AdminResultsResponse;
    expect(page2.items.map((r) => r.id)).toEqual([ids[1], ids[0]]);
    const errors = (
      await call(
        "GET",
        `/api/admin/results?status=error&modelId=${m.id}&promptId=${p.id}`,
      )
    ).data as AdminResultsResponse;
    expect(errors.items.map((r) => r.id)).toEqual([ids[1]]);
    expect(errors.items[0]?.error).toBe("坏了");
    const clamped = (await call("GET", "/api/admin/results?pageSize=1000"))
      .data as AdminResultsResponse;
    expect(clamped.pageSize).toBe(100);

    for (const query of [
      "status=done",
      "page=0",
      "modelId=abc",
      "pageSize=-1",
    ]) {
      expect((await call("GET", `/api/admin/results?${query}`)).status).toBe(
        400,
      );
    }
  });

  it("查看单条、删除（running 409）、清空", async () => {
    const { m, insert } = await seed();
    const done = insert("success");
    const running = insert("running");
    const detail = await call("GET", `/api/admin/results/${done}`);
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({
      id: done,
      output: "out",
      status: "success",
    } satisfies Partial<ResultDetail>);
    expect((await call("GET", "/api/admin/results/999")).status).toBe(404);

    const conflict = await call("DELETE", `/api/admin/results/${running}`);
    expect(conflict.status).toBe(409);
    expect((await call("DELETE", `/api/admin/results/${done}`)).status).toBe(
      204,
    );
    expect((await call("DELETE", `/api/admin/results/${done}`)).status).toBe(
      404,
    );

    insert("success");
    insert("error");
    const cleared = await call("DELETE", `/api/admin/results?modelId=${m.id}`);
    expect(cleared.data).toEqual({ deleted: 2 });
    insert("success");
    expect((await call("DELETE", "/api/admin/results")).data).toEqual({
      deleted: 1,
    });
    expect(repo.getResult(running)?.status).toBe("running");
  });
});

describe("设置", () => {
  it("读取、修改、校验；保留条数改小时立即清理", async () => {
    const initial = await call("GET", "/api/admin/settings");
    expect(initial.data).toEqual({
      siteTitle: "模型智商检测",
      siteDescription: "定时向各家大模型发出同一组检测题，原样展示它们的回答。",
      retentionPerCheck: 20,
      maxConcurrency: 2,
    } satisfies Settings);

    const ch = await createChannel();
    const p = await createPrompt();
    const m = await createModel(ch.id, { promptIds: [p.id] });
    for (let i = 0; i < 5; i++) {
      const id = repo.insertRunningResult({
        modelId: m.id,
        promptId: p.id,
        promptSnapshot: "x",
        stream: true,
        startedAt: new Date().toISOString(),
        trigger: "schedule",
      });
      repo.finishResult(id, {
        status: "success",
        output: "",
        reasoning: "",
        error: null,
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        firstTokenMs: null,
        inputTokens: null,
        outputTokens: null,
        finishReason: null,
      });
    }

    const updated = await call("PUT", "/api/admin/settings", {
      siteTitle: "  我的检测站  ",
      siteDescription: "",
      retentionPerCheck: 2,
      maxConcurrency: 4,
    });
    expect(updated.status).toBe(200);
    expect(updated.data).toEqual({
      siteTitle: "我的检测站",
      siteDescription: "",
      retentionPerCheck: 2,
      maxConcurrency: 4,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM results").get()?.n).toBe(2);
    expect(repo.getSettings().siteDescription).toBe("");

    for (const [body, message] of [
      [{ siteTitle: "" }, "站点标题不能为空"],
      [{ siteDescription: "d".repeat(501) }, "站点说明不能超过 500 个字符"],
      [{ retentionPerCheck: 0 }, "保留条数必须是 1 到 1000 之间的整数"],
      [{ maxConcurrency: 21 }, "同时检测数必须是 1 到 20 之间的整数"],
    ] as const) {
      const r = await call("PUT", "/api/admin/settings", body);
      expect(r.status).toBe(400);
      expect(r.data).toEqual({ error: message });
    }
  });
});

describe("其他", () => {
  it("没匹配到的接口返回 404 JSON", async () => {
    const res = await call("GET", "/api/admin/nope");
    expect(res.status).toBe(404);
    expect(res.data).toEqual({ error: "接口不存在" });
    expect(res.res.headers.get("cache-control")).toBe("no-store");
  });

  it("客户端支持时压缩接口响应", async () => {
    const channel = await createChannel();
    const prompt = await call("POST", "/api/admin/prompts", {
      title: "长提示词",
      content: "很长的提示词".repeat(1000),
      enabled: true,
      sortOrder: 0,
    });
    await createModel(channel.id, {
      promptIds: [(prompt.data as AdminPrompt).id],
    });
    const res = await app.request(`${BASE}/api/public/board`, {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const zipped = Buffer.from(await res.arrayBuffer());
    const board = JSON.parse(gunzipSync(zipped).toString("utf8")) as {
      generatedAt: string;
    };
    expect(JSON.stringify(board)).toContain("很长的提示词");
    expect(zipped.length).toBeLessThan(2000);

    const plain = await app.request(`${BASE}/api/public/board`);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.json()).toEqual({
      ...board,
      generatedAt: expect.any(String),
    });
  });

  it("请求体太大返回 413", async () => {
    const res = await call("POST", "/api/admin/prompts", undefined, {
      raw: JSON.stringify({ title: "t", content: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
