/**
 * 组装 Hono 应用（不监听端口）：测试里直接用 app.request()，server/index.ts 再交给 serve()。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import * as providers from "./providers/index.ts";
import { createAuth, LoginLimiter, requestHosts } from "./auth.ts";
import { proxyHops, type AuthConfig } from "./config.ts";
import type { Repo } from "./repo.ts";
import { adminRoutes, type ListModelsFn } from "./routes/admin.ts";
import { publicRoutes } from "./routes/public.ts";
import type { SchedulerControl } from "./scheduler.ts";
import { createStaticHandler } from "./static.ts";

export interface CreateAppOptions {
  repo: Repo;
  scheduler: SchedulerControl;
  config: AuthConfig;
  /** 拉取上游模型列表；默认是真正的 providers 实现 */
  listModels?: ListModelsFn;
  /** vite build 产物目录；null 表示开发模式（非 API 请求返回说明文字） */
  staticDir?: string | null;
  /** 记录未预期的错误 */
  onError?: (err: unknown) => void;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 只取主机名、不管端口：反向代理常把端口弄丢（Host $host）或换成内部端口。
 * 只给不发 Sec-Fetch-Site 的旧浏览器兜底用（见 isSameOriginWrite）
 */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * 写请求是不是来自本站页面。浏览器发了 Sec-Fetch-Site（页面脚本改不了，也不受代理改写 Host 影响）
 * 就只认 same-origin：同一主机的其他端口是 same-site，那里的页面也不能来写。
 * 没发时（旧浏览器、curl 之类）才看 Origin：带了且主机名和请求的 Host 都对不上就拒绝，不带放行。
 */
function isSameOriginWrite(c: Context, trustProxy: number): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined) return site.trim().toLowerCase() === "same-origin";
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  let originHost: string | null = null;
  try {
    originHost = hostnameOf(new URL(origin).host);
  } catch {
    originHost = null;
  }
  const hosts = requestHosts(c, trustProxy).map(hostnameOf);
  return originHost !== null && hosts.includes(originHost);
}

export function createApp(options: CreateAppOptions) {
  const { repo, scheduler, config } = options;
  const trustProxy = proxyHops(config.trustProxy);
  const listModels = options.listModels ?? providers.listModels;
  const auth = createAuth({
    username: config.adminUsername,
    password: config.adminPassword,
    secret: config.sessionSecret,
  });
  const limiter = new LoginLimiter();
  const app = new Hono();

  // 所有响应都加的安全头；HTML 另加防点击劫持。不加 CSP：前端用 iframe srcdoc 展示模型生成的网页，
  // srcdoc 文档会继承父页面的 CSP，严格的 CSP 会让那些网页里的脚本跑不起来
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "same-origin");
    if (c.res.headers.get("Content-Type")?.startsWith("text/html")) {
      c.res.headers.set("X-Frame-Options", "SAMEORIGIN");
    }
  });

  app.use("/api/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  // 公开看板轮询频繁、内容多是重复的文本，压缩后小得多（按 Accept-Encoding 选 gzip / deflate）
  app.use("/api/*", compress());

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "请求体太大" }, 413),
    }),
  );

  // 防跨站请求（Cookie 已是 SameSite=Strict，这里再加一道），规则见 isSameOriginWrite
  app.use("/api/admin/*", async (c, next) => {
    const method = c.req.method;
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      !isSameOriginWrite(c, trustProxy)
    ) {
      return c.json({ error: "跨站请求被拒绝" }, 403);
    }
    await next();
  });

  app.route("/api/public", publicRoutes({ repo, runtime: scheduler }));
  app.route(
    "/api/admin",
    adminRoutes({
      repo,
      scheduler,
      auth,
      limiter,
      username: config.adminUsername,
      trustProxy,
      listModels,
    }),
  );

  app.all("/api/*", (c) => c.json({ error: "接口不存在" }, 404));

  const serveStatic = createStaticHandler(options.staticDir ?? null);
  app.get("*", (c) => serveStatic(c));
  app.all("*", (c) => c.text("不存在", 404));

  app.onError((err, c) => {
    if (options.onError) options.onError(err);
    else console.error("[http] 未处理的错误", err);
    return c.json({ error: "服务器内部错误" }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
