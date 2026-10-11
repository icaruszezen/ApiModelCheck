/**
 * 后台接口。除登录、退出外都要求有效会话；路径和请求体与 web/src/api/client.ts 对应。
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ListModelsRequest } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import type {
  AdminSession,
  ChannelInput,
  PromptInput,
  ModelInput,
} from "../../shared/types.ts";
import {
  clientIp,
  isHttps,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type Auth,
  type LoginLimiter,
} from "../auth.ts";
import type { Repo } from "../repo.ts";
import type { SchedulerControl } from "../scheduler.ts";
import {
  channelSchema,
  loginSchema,
  modelSchema,
  parseId,
  parseLimit,
  parseOptionalInt,
  parseStatus,
  promptSchema,
  runSchema,
  settingsSchema,
  validate,
  type Validated,
} from "../validation.ts";
import type { z } from "zod";

export type ListModelsFn = (request: ListModelsRequest) => Promise<string[]>;

export interface AdminRoutesDeps {
  repo: Repo;
  scheduler: SchedulerControl;
  auth: Auth;
  limiter: LoginLimiter;
  username: string;
  /** 信任的反向代理层数，0 表示不信任 */
  trustProxy: number;
  listModels: ListModelsFn;
}

type AdminEnv = { Variables: { username: string } };

export const UNAUTHORIZED_MESSAGE = "未登录或登录已过期";

/** 读 JSON 请求体：空体当作 {}，不是合法 JSON 时返回 null */
async function readJson(c: Context): Promise<{ value: unknown } | null> {
  const text = await c.req.text();
  if (text.trim() === "") return { value: {} };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

async function parseBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<Validated<T>> {
  const body = await readJson(c);
  if (!body) return { ok: false, error: "请求体不是合法的 JSON" };
  return validate(schema, body.value);
}

function formatIds(ids: number[]): string {
  return ids.map((id) => `#${id}`).join("、");
}

function upstreamErrorText(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  if (err instanceof Error && err.name === "AbortError") return "请求超时";
  if (err instanceof Error && err.name === "TimeoutError") return "请求超时";
  return err instanceof Error ? err.message : String(err);
}

export function adminRoutes(deps: AdminRoutesDeps) {
  const { repo, scheduler, auth, limiter, trustProxy } = deps;
  const app = new Hono<AdminEnv>();

  /* ------------------------------ 认证 ------------------------------ */

  app.post("/login", async (c) => {
    const ip = clientIp(c, trustProxy);
    const blocked = () =>
      c.json({ error: "登录尝试过多，请 15 分钟后再试" }, 429);
    // 先查一次：已封禁的 IP 不用等请求体传完
    if (limiter.isBlocked(ip)) return blocked();
    const parsed = await parseBody(c, loginSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    // 等请求体期间别的请求可能已把这个 IP 封禁（同时发来一大批请求），比对密码前再查一次；
    // 从这里到记下失败之间没有 await，每个窗口最多比对 LOGIN_MAX_FAILURES 次
    if (limiter.isBlocked(ip)) return blocked();
    if (!auth.checkCredentials(parsed.data.username, parsed.data.password)) {
      limiter.recordFailure(ip);
      return c.json({ error: "用户名或密码错误" }, 401);
    }
    limiter.recordSuccess(ip);
    setCookie(c, SESSION_COOKIE, auth.issueToken(), {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
      secure: isHttps(c, trustProxy),
    });
    const body: AdminSession = { username: deps.username };
    return c.json(body);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure: isHttps(c, trustProxy),
    });
    return c.body(null, 204);
  });

  // 注册在登录 / 退出之后：上面两个路由先匹配并直接返回，不经过这里
  app.use("*", async (c, next) => {
    const username = auth.verifyToken(getCookie(c, SESSION_COOKIE));
    if (!username) return c.json({ error: UNAUTHORIZED_MESSAGE }, 401);
    c.set("username", username);
    await next();
  });

  app.get("/me", (c) => {
    const body: AdminSession = { username: c.get("username") };
    return c.json(body);
  });

  /* ------------------------------ 渠道 ------------------------------ */

  app.get("/channels", (c) => c.json(repo.listAdminChannels()));

  app.post("/channels", async (c) => {
    const parsed = await parseBody<ChannelInput>(c, channelSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const id = repo.createChannel({
      ...parsed.data,
      apiKey: parsed.data.apiKey ?? "",
    });
    return c.json(repo.getAdminChannel(id), 201);
  });

  app.put("/channels/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !repo.getChannel(id)) {
      return c.json({ error: "渠道不存在" }, 404);
    }
    const parsed = await parseBody<ChannelInput>(c, channelSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (!repo.updateChannel(id, parsed.data)) {
      return c.json({ error: "渠道不存在" }, 404);
    }
    return c.json(repo.getAdminChannel(id));
  });

  app.delete("/channels/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !repo.getChannel(id)) {
      return c.json({ error: "渠道不存在" }, 404);
    }
    // 先取出模型再删，级联删除后就查不到了
    for (const modelId of repo.listModelIdsByChannel(id))
      scheduler.cancelModel(modelId);
    repo.deleteChannel(id);
    return c.body(null, 204);
  });

  app.get("/channels/:id/upstream-models", async (c) => {
    const id = parseId(c.req.param("id"));
    const channel = id === null ? undefined : repo.getChannel(id);
    if (!channel) return c.json({ error: "渠道不存在" }, 404);
    try {
      const models = await deps.listModels({
        endpointType: channel.endpointType,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        extraHeaders: channel.extraHeaders,
      });
      return c.json({ models });
    } catch (err) {
      return c.json(
        { error: `拉取模型列表失败：${upstreamErrorText(err)}` },
        502,
      );
    }
  });

  /* ----------------------------- 提示词 ----------------------------- */

  app.get("/prompts", (c) => c.json(repo.listAdminPrompts()));

  app.post("/prompts", async (c) => {
    const parsed = await parseBody<PromptInput>(c, promptSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const missing = repo.missingModelIds(parsed.data.modelIds ?? []);
    if (missing.length) {
      return c.json({ error: `模型不存在：${formatIds(missing)}` }, 400);
    }
    const id = repo.createPrompt(parsed.data);
    return c.json(repo.getAdminPrompt(id), 201);
  });

  app.put("/prompts/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !repo.getPrompt(id)) {
      return c.json({ error: "提示词不存在" }, 404);
    }
    const parsed = await parseBody<PromptInput>(c, promptSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const missing = repo.missingModelIds(parsed.data.modelIds ?? []);
    if (missing.length) {
      return c.json({ error: `模型不存在：${formatIds(missing)}` }, 400);
    }
    if (!repo.updatePrompt(id, parsed.data)) {
      return c.json({ error: "提示词不存在" }, 404);
    }
    return c.json(repo.getAdminPrompt(id));
  });

  app.delete("/prompts/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !repo.getPrompt(id)) {
      return c.json({ error: "提示词不存在" }, 404);
    }
    scheduler.cancelPrompt(id);
    repo.deletePrompt(id);
    return c.body(null, 204);
  });

  /* ------------------------------ 模型 ------------------------------ */

  app.get("/models", (c) => c.json(repo.listAdminModels(scheduler)));

  /** 渠道和提示词都存在才能保存；返回错误信息或 null */
  function checkModelRefs(data: ModelInput): string | null {
    if (!repo.getChannel(data.channelId)) return "渠道不存在";
    const missing = repo.missingPromptIds(data.promptIds);
    if (missing.length) return `提示词不存在：${formatIds(missing)}`;
    return null;
  }

  app.post("/models", async (c) => {
    const parsed = await parseBody<ModelInput>(c, modelSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const refError = checkModelRefs(parsed.data);
    if (refError) return c.json({ error: refError }, 400);
    const id = repo.createModel(parsed.data);
    return c.json(repo.getAdminModel(id, scheduler), 201);
  });

  app.put("/models/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !repo.getModel(id)) {
      return c.json({ error: "模型不存在" }, 404);
    }
    const parsed = await parseBody<ModelInput>(c, modelSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const refError = checkModelRefs(parsed.data);
    if (refError) return c.json({ error: refError }, 400);
    if (!repo.updateModel(id, parsed.data)) {
      return c.json({ error: "模型不存在" }, 404);
    }
    return c.json(repo.getAdminModel(id, scheduler));
  });

  app.delete("/models/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !repo.getModel(id)) {
      return c.json({ error: "模型不存在" }, 404);
    }
    scheduler.cancelModel(id);
    repo.deleteModel(id);
    return c.body(null, 204);
  });

  app.post("/models/:id/run", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !repo.getModel(id)) {
      return c.json({ error: "模型不存在" }, 404);
    }
    const parsed = await parseBody(c, runSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const prompts = repo.listEnabledPromptsOfModel(id);
    const { promptId } = parsed.data;
    if (
      promptId !== undefined &&
      !prompts.some((prompt) => prompt.id === promptId)
    ) {
      return c.json({ error: "这条提示词没有分配给该模型，或者已经停用" }, 400);
    }
    if (prompts.length === 0) {
      return c.json({ error: "这个模型还没有分配启用的提示词" }, 400);
    }
    const result = scheduler.trigger(id, promptId);
    return c.json(result, result.queued ? 202 : 200);
  });

  /* ------------------------------ 记录 ------------------------------ */

  app.get("/results", (c) => {
    const modelId = parseOptionalInt(c.req.query("modelId"));
    if (modelId === null) return c.json({ error: "modelId 必须是正整数" }, 400);
    const promptId = parseOptionalInt(c.req.query("promptId"));
    if (promptId === null)
      return c.json({ error: "promptId 必须是正整数" }, 400);
    const status = parseStatus(c.req.query("status"));
    if (status === null)
      return c.json(
        { error: "状态只能是 running、success、error 或 timeout" },
        400,
      );
    const page = parseLimit(c.req.query("page"), 1, Number.MAX_SAFE_INTEGER);
    if (page === null) return c.json({ error: "page 必须是正整数" }, 400);
    const pageSize = parseLimit(c.req.query("pageSize"), 20, 100);
    if (pageSize === null)
      return c.json({ error: "pageSize 必须是正整数" }, 400);
    return c.json(
      repo.listAdminResults({ modelId, promptId, status, page, pageSize }),
    );
  });

  app.get("/results/:id", (c) => {
    const id = parseId(c.req.param("id"));
    const result = id === null ? undefined : repo.getResult(id, scheduler);
    if (!result) return c.json({ error: "记录不存在" }, 404);
    return c.json(result);
  });

  app.delete("/results/:id", (c) => {
    const id = parseId(c.req.param("id"));
    const outcome = id === null ? "missing" : repo.deleteResult(id);
    if (outcome === "missing") return c.json({ error: "记录不存在" }, 404);
    if (outcome === "running") {
      return c.json({ error: "这条检测还在进行中，不能删除" }, 409);
    }
    return c.body(null, 204);
  });

  app.delete("/results", (c) => {
    const modelId = parseOptionalInt(c.req.query("modelId"));
    if (modelId === null) return c.json({ error: "modelId 必须是正整数" }, 400);
    return c.json({ deleted: repo.clearResults(modelId) });
  });

  /* ------------------------------ 设置 ------------------------------ */

  app.get("/settings", (c) => c.json(repo.getSettings()));

  app.put("/settings", async (c) => {
    const parsed = await parseBody(c, settingsSchema);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const before = repo.getSettings();
    const settings = repo.updateSettings(parsed.data);
    // 保留条数改小了，立刻按新规则清理
    if (settings.retentionPerCheck < before.retentionPerCheck) {
      repo.pruneAllResults(settings.retentionPerCheck);
    }
    return c.json(settings);
  });

  return app;
}
