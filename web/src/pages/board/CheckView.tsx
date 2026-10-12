import { Button } from "@endfield-ui/react";
import { Link } from "react-router";
import type { BoardCheck, BoardModel } from "../../../../shared/types.ts";
import {
  changedSnapshot,
  modelPath,
  resolveCheckDisplay,
} from "./board-logic";
import { PromptBlock } from "./PromptBlock";
import { LatestResult } from "./ResultBody";

export interface CheckViewProps {
  model: BoardModel;
  check: BoardCheck;
  /** 模型只有这一条检测题（没有页签）：题目标题写在提示词上面 */
  single: boolean;
}

/** 首页卡片里的一条检测题：提示词和最近一次的结果。以前的结果到模型详情页看 */
export function CheckView({ model, check, single }: CheckViewProps) {
  const display = resolveCheckDisplay(check);
  // 提示词跟着显示的那次结果走：管理员改过题时，显示当时用的版本
  const shown = display.kind === "never" ? null : display.result;

  return (
    <div className="flex min-w-0 flex-col gap-4 p-3">
      <PromptBlock
        content={check.prompt.content}
        snapshot={changedSnapshot(check.prompt.content, shown)}
        title={single ? check.prompt.title : undefined}
        compact
      />
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h4 className="font-tech text-xs text-ink-secondary">
            <span aria-hidden="true">{"// "}</span>
            最新结果
          </h4>
          {check.latest && (
            <Button
              variant="text"
              size="sm"
              render={<Link to={modelPath(model.id, check.prompt.id)} />}
              aria-label={`查看「${check.prompt.title}」的历史记录`}
            >
              历史记录
            </Button>
          )}
        </div>
        <LatestResult model={model} display={display} compact />
      </section>
    </div>
  );
}
