import { cn, Spinner } from "@endfield-ui/react";
import { CopyButton } from "./CopyButton";

export interface CodeBlockProps {
  code: string;
  /** 围栏上写的语言，没写就是空串 */
  lang?: string;
  /** 围栏已经闭合 */
  complete?: boolean;
  /** 输出还在生成中 */
  running?: boolean;
  /** 紧凑版（前台卡片里）：不垫凹陷底色（暗色主题下是纯黑），矮一些 */
  compact?: boolean;
  className?: string;
}

/** 模型输出里的代码块：等宽、凹陷底色、可横向滚动，顶上是语言和复制 */
export function CodeBlock({
  code,
  lang = "",
  complete = true,
  running = false,
  compact = false,
  className,
}: CodeBlockProps) {
  return (
    <div className={cn("min-w-0 border border-line", !compact && "bg-surface-sunken", className)}>
      <div
        className={cn(
          "flex items-center gap-3 border-b border-line py-1 pr-1 pl-3",
          compact ? "min-h-9 py-0.5 pr-0.5 pl-2.5" : "min-h-10",
        )}
      >
        <span className="truncate font-tech text-xs font-medium tracking-wider text-ink-secondary uppercase">
          {lang || "代码"}
        </span>
        {!complete &&
          (running ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-ink-tertiary">
              <Spinner size="sm" label={null} />
              生成中
            </span>
          ) : (
            <span className="shrink-0 text-xs text-warning">没有写完</span>
          ))}
        <CopyButton
          text={code}
          label="复制代码"
          className={cn("ml-auto", compact && "bg-transparent hover:bg-ink/5")}
        />
      </div>
      <pre
        tabIndex={0}
        aria-label={`${lang || "代码"}代码`}
        className={cn(
          "overflow-auto font-mono text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
          compact ? "max-h-64 p-2.5 text-xs" : "max-h-128 p-3 text-sm",
          // 行高写在字号后面：cn 合并时字号类会顶掉排在它前面的行高
          "leading-relaxed",
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
