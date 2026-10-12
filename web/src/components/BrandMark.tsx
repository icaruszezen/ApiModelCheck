import { cn } from "@endfield-ui/react";

export interface BrandMarkProps {
  /** 站点标题，默认"模型智商检测" */
  title?: string;
  /** 只要标志、不要文字 */
  compact?: boolean;
  className?: string;
}

/** 站点标志：黄色方块里一个 "IQ"，旁边是标题 */
export function BrandMark({ title = "模型智商检测", compact = false, className }: BrandMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="inline-flex size-8 shrink-0 items-center justify-center bg-action font-display text-sm font-bold text-on-action"
      >
        IQ
      </span>
      {!compact && (
        <span className="truncate text-base font-bold tracking-wide">{title}</span>
      )}
    </span>
  );
}
