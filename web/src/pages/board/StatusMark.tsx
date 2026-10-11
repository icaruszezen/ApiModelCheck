import { cn, Spinner } from "@endfield-ui/react";
import type { ResultStatus } from "../../../../shared/types.ts";

/*
 * 四种结果用四种外形，和组件库提示条的图标同一套：成功是圆、超时是三角、失败是菱形，
 * 从没检测过是空心方块。不只靠颜色区分；高对比模式下底色被系统换掉，改用字色填充
 */
const shape: Record<Exclude<ResultStatus, "running">, string> = {
  success: "size-2 rounded-full bg-success",
  timeout: "size-2.5 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]",
  error: "size-[7px] rotate-45 bg-danger",
};

export interface StatusMarkProps {
  /** 最近一条记录的状态；从没检测过是 null */
  status: ResultStatus | null;
  className?: string;
}

/** 页签上的小状态记号。纯装饰：状态的文字由使用方另外给读屏 */
export function StatusMark({ status, className }: StatusMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-3 shrink-0 items-center justify-center",
        className,
      )}
    >
      {status === "running" ? (
        <Spinner size="sm" label={null} />
      ) : status === null ? (
        <span className="size-2 border border-line-strong" />
      ) : (
        <span className={cn(shape[status], "forced-colors:bg-[CanvasText]")} />
      )}
    </span>
  );
}
