/**
 * 组装 Hono 应用（不监听端口）：测试里直接用 app.request()，server/index.ts 再交给 serve()。
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as providers from "./providers/index.ts";
import { createAuth, LoginLimiter, requestHosts } from "./auth.ts";
import type { AuthConfig } from "./config.ts";
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

/** 去掉默认端口，免得 "example.com" 和 "example.com:443" 被当成不同的主机 */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:(80|443)$/, "");
}

export function createApp(options: CreateAppOptions) {
  const { repo, scheduler, config } = options;
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

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "请求体太大" }, 413),
    }),
  );

  // 防跨站请求：带了 Origin 且和请求的 Host 不一致就拒绝（Cookie 已是 SameSite=Strict，这里再加一道）
  app.use("/api/admin/*", async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        let originHost: string | null = null;
        try {
          originHost = normalizeHost(new URL(origin).host);
        } catch {
          originHost = null;
        }
        const hosts = requestHosts(c, config.trustProxy).map(normalizeHost);
        if (!originHost || !hosts.includes(originHost)) {
          return c.json({ error: "跨站请求被拒绝" }, 403);
        }
      }
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
      trustProxy: config.trustProxy,
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
