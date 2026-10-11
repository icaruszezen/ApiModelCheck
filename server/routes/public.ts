/**
 * 前台接口（不需登录）。返回的数据里绝不能有 API 密钥、基础地址、额外请求头。
 */
import { Hono } from "hono";
import type { HistoryResponse } from "../../shared/types.ts";
import type { Repo, RuntimeView } from "../repo.ts";
import { parseId, parseLimit } from "../validation.ts";

export interface PublicRoutesDeps {
  repo: Repo;
  runtime: RuntimeView;
}

export function publicRoutes({ repo, runtime }: PublicRoutesDeps) {
  const app = new Hono();

  app.get("/board", (c) => c.json(repo.getBoard(runtime)));

  app.get("/history", (c) => {
    const modelId = parseId(c.req.query("modelId"));
    const promptId = parseId(c.req.query("promptId"));
    if (modelId === null || promptId === null) {
      return c.json({ error: "modelId 和 promptId 必须是正整数" }, 400);
    }
    const limit = parseLimit(c.req.query("limit"), 20, 100);
    if (limit === null) {
      return c.json({ error: "limit 必须是正整数" }, 400);
    }
    // 停用 / 不存在 / 已取消分配的"模型 × 提示词"对访客不可见
    if (!repo.isCheckVisible(modelId, promptId)) {
      return c.json({ error: "不存在" }, 404);
    }
    const body: HistoryResponse = {
      items: repo.listHistory(modelId, promptId, limit),
    };
    return c.json(body);
  });

  app.get("/results/:id", (c) => {
    const id = parseId(c.req.param("id"));
    const result = id === null ? undefined : repo.getResult(id, runtime);
    if (!result || !repo.isCheckVisible(result.modelId, result.promptId)) {
      return c.json({ error: "记录不存在" }, 404);
    }
    return c.json(result);
  });

  return app;
}
