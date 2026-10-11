/**
 * 模型列表页的纯逻辑：显示名、筛选、检测题统计、"下次检测"的说法。
 */
import type { AdminModel, AdminPrompt } from "../../../../shared/types.ts";

/** 显示名，没填时用模型 ID */
export function modelLabel(
  model: Pick<AdminModel, "displayName" | "model">,
): string {
  return model.displayName.trim() || model.model;
}

export interface ModelFilter {
  /** null 表示全部渠道 */
  channelId: number | null;
  /** 匹配显示名或模型 ID，不分大小写 */
  query: string;
}

export function filterModels(
  models: readonly AdminModel[],
  filter: ModelFilter,
): AdminModel[] {
  const query = filter.query.trim().toLowerCase();
  return models.filter((model) => {
    if (filter.channelId !== null && model.channelId !== filter.channelId) {
      return false;
    }
    if (query === "") return true;
    return (
      model.model.toLowerCase().includes(query) ||
      model.displayName.toLowerCase().includes(query)
    );
  });
}

export interface PromptStats {
  /** 分配了几条 */
  assigned: number;
  /** 其中启用的（真正会被检测的） */
  enabled: number;
  /** 其中停用的 */
  disabled: number;
}

/**
 * 统计模型分配到的提示词。提示词列表还没载入时，把分配的都当作启用的，
 * 免得一闪而过地显示"均已停用"。
 */
export function promptStats(
  model: Pick<AdminModel, "promptIds">,
  prompts: readonly AdminPrompt[] | undefined,
): PromptStats {
  const assigned = model.promptIds.length;
  if (!prompts) return { assigned, enabled: assigned, disabled: 0 };
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  let enabled = 0;
  let disabled = 0;
  for (const id of model.promptIds) {
    const prompt = byId.get(id);
    if (!prompt) continue;
    if (prompt.enabled) enabled++;
    else disabled++;
  }
  return { assigned, enabled, disabled };
}

export type NextRunInfo =
  | { kind: "running" }
  | { kind: "model-disabled" }
  | { kind: "channel-disabled" }
  | { kind: "no-prompts" }
  /** 从没检测过、或者已经到期：调度器下一次巡检就会开始 */
  | { kind: "soon" }
  | { kind: "at"; at: string };

/** 下次检测什么时候、或者为什么不会检测。判断顺序和调度器的"到期"条件一致 */
export function describeNextRun(
  model: Pick<AdminModel, "running" | "enabled" | "nextRunAt">,
  context: { channelEnabled: boolean; enabledPrompts: number },
  now: number,
): NextRunInfo {
  if (model.running) return { kind: "running" };
  if (!model.enabled) return { kind: "model-disabled" };
  if (!context.channelEnabled) return { kind: "channel-disabled" };
  if (context.enabledPrompts === 0) return { kind: "no-prompts" };
  if (!model.nextRunAt) return { kind: "soon" };
  const at = new Date(model.nextRunAt).getTime();
  if (Number.isNaN(at) || at <= now) return { kind: "soon" };
  return { kind: "at", at: model.nextRunAt };
}

/** 不是具体时间的那几种情况的说法 */
export const NEXT_RUN_TEXT: Record<
  Exclude<NextRunInfo["kind"], "at">,
  string
> = {
  running: "本轮进行中",
  "model-disabled": "已停用",
  "channel-disabled": "渠道已停用",
  "no-prompts": "没有检测题",
  soon: "即将开始",
};

export function anyRunning(models: readonly { running: boolean }[]): boolean {
  return models.some((model) => model.running);
}
