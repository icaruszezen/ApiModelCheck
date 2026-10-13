import type { BoardCheck, BoardModel } from "../../../../shared/types.ts";
import { changedSnapshot, resolveCheckDisplay } from "./board-logic";
import { PromptBlock } from "./PromptBlock";
import { LatestResult } from "./ResultBody";

export interface CheckViewProps {
  model: BoardModel;
  check: BoardCheck;
}

/**
 * 首页卡片里的一条检测题：一问一答。上面是淡色的题目，下面是最近一次的结果。
 * 以前的结果到模型详情页看，入口在卡片底部
 */
export function CheckView({ model, check }: CheckViewProps) {
  const display = resolveCheckDisplay(check);
  // 提示词跟着显示的那次结果走：管理员改过题时，显示当时用的版本
  const shown = display.kind === "never" ? null : display.result;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PromptBlock
        content={check.prompt.content}
        snapshot={changedSnapshot(check.prompt.content, shown)}
        compact
      />
      <section className="flex min-w-0 flex-col gap-3">
        <h4 className="sr-only">最新结果</h4>
        <LatestResult model={model} display={display} compact />
      </section>
    </div>
  );
}
