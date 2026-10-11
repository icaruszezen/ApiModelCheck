import { cn, Spinner, Tag, type TagVariant } from "@endfield-ui/react";
import type { ResultStatus } from "../../../../shared/types.ts";

export interface StatusTagProps {
  status: ResultStatus;
  size?: "sm" | "md";
}

/** 各状态的中文名，下拉框、表格里要纯文字时也用它 */
export const STATUS_LABELS: Record<ResultStatus, string> = {
  running: "检测中",
  success: "成功",
  error: "失败",
  timeout: "超时",
};

/*
 * 四种状态文字不同、底色不同、前面的记号也不同（转动的方块 / 绿方块 / 红角 / 黄方块），
 * 不只靠颜色区分。失败用墨底加红角，和组件库示例里"已延误"的写法一致
 */
const STATUS_STYLE: Record<ResultStatus, { variant: TagVariant; dot?: string; marked?: boolean }> = {
  running: { variant: "accent" },
  success: { variant: "outline", dot: "bg-success" },
  error: { variant: "inverse", marked: true },
  timeout: { variant: "muted", dot: "bg-warning" },
};

export function StatusTag({ status, size = "sm" }: StatusTagProps) {
  const style = STATUS_STYLE[status] ?? { variant: "outline" as const };
  const label = STATUS_LABELS[status] ?? status;
  return (
    <Tag
      size={size}
      variant={style.variant}
      marked={style.marked}
      data-status={status}
      className={size === "sm" ? "gap-1.5" : "gap-2"}
    >
      {status === "running" ? (
        <Spinner size="sm" label={null} className={size === "sm" ? "size-2" : undefined} />
      ) : (
        style.dot && (
          <span
            aria-hidden="true"
            className={cn("inline-block shrink-0", style.dot, size === "sm" ? "size-1.5" : "size-2")}
          />
        )
      )}
      {label}
    </Tag>
  );
}
