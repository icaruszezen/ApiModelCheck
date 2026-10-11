import {
  cn,
  Dialog,
  IconButton,
  Segment,
  SegmentedControl,
  Spinner,
  StatusWarning,
  Tooltip,
} from "@endfield-ui/react";
import { useMemo, useState } from "react";
import { CodeIcon, ExpandIcon, EyeIcon, RefreshIcon } from "../icons";
import { CopyButton } from "./CopyButton";
import { SandboxFrame } from "./SandboxFrame";
import { buildSrcDoc, byteLength, formatBytes, tailLines, type HtmlSource } from "./srcdoc";

/** 小方框的高度 */
const BOX_HEIGHT = 360;
/** 生成中显示源码的最后多少行 */
const TAIL_LINES = 40;
/** 全屏弹窗里 iframe 的高度：约 80vh，矮屏上给标题带和内边距留出位置 */
const DIALOG_FRAME_HEIGHT = "min(80vh, calc(100dvh - 13rem))";

export interface HtmlPreviewProps {
  html: string;
  source: HtmlSource;
  /** 网页已经写完（围栏闭合了 / 找到了 </html>） */
  complete: boolean;
  /** 输出还在生成中 */
  running?: boolean;
  /** 同一段输出里有多个网页时的序号（从 1 起），用在标题里 */
  index?: number;
  className?: string;
}

type View = "preview" | "source";

/**
 * 模型生成的网页：一个小方框里用沙箱 iframe 渲染，顶上一条工具条（预览 / 源码、复制、全屏）。
 * 生成中且还没写完时不渲染 iframe（每来一段增量就重载一次既闪又费），先显示源码的末尾。
 */
export function HtmlPreview({
  html,
  source,
  complete,
  running = false,
  index,
  className,
}: HtmlPreviewProps) {
  const [view, setView] = useState<View>("preview");
  const [fullscreen, setFullscreen] = useState(false);
  // 换 key 让 iframe 重新挂载，网页从头再跑一遍（动画放完了、游戏结束了）
  const [runId, setRunId] = useState(0);
  const srcDoc = useMemo(() => buildSrcDoc(html, source), [html, source]);
  const size = useMemo(() => formatBytes(byteLength(html)), [html]);
  const title = index ? `模型生成的网页 ${index}` : "模型生成的网页";
  const generating = running && !complete;

  return (
    <div
      role="group"
      aria-label={title}
      className={cn("min-w-0 border border-line bg-surface-raised", className)}
    >
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-sunken py-1 pr-1 pl-3">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-secondary">
          <span className="font-medium text-ink">HTML 网页</span>
          <span aria-hidden="true">·</span>
          <span className="font-tech tabular-nums">{size}</span>
          {generating && (
            <>
              <span aria-hidden="true">·</span>
              <Spinner size="sm" label={null} />
              <span>生成中</span>
            </>
          )}
        </span>
        {!generating && (
          <div className="ml-auto flex items-center gap-1">
            <SegmentedControl
              size="sm"
              variant="outline"
              aria-label="显示方式"
              value={view}
              onValueChange={(next) => setView(next === "source" ? "source" : "preview")}
            >
              <Segment value="preview" icon={<EyeIcon />}>
                预览
              </Segment>
              <Segment value="source" icon={<CodeIcon />}>
                源码
              </Segment>
            </SegmentedControl>
            {view === "preview" && (
              <Tooltip content="重新运行">
                <IconButton size="sm" aria-label="重新运行" onClick={() => setRunId((id) => id + 1)}>
                  <RefreshIcon />
                </IconButton>
              </Tooltip>
            )}
            <CopyButton text={html} label="复制网页源码" />
            <Tooltip content="全屏查看">
              <IconButton size="sm" aria-label="全屏查看" onClick={() => setFullscreen(true)}>
                <ExpandIcon />
              </IconButton>
            </Tooltip>
          </div>
        )}
      </div>

      {!complete && !running && (
        <p className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-secondary">
          <StatusWarning size={14} className="shrink-0 text-warning" />
          网页没有写完（输出可能被截断）
        </p>
      )}

      {generating ? (
        <GeneratingTail html={html} />
      ) : view === "preview" ? (
        <SandboxFrame key={runId} srcDoc={srcDoc} title={title} height={BOX_HEIGHT} />
      ) : (
        <pre
          tabIndex={0}
          aria-label="网页源码"
          className="overflow-auto bg-surface-sunken p-3 font-mono text-xs leading-relaxed text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
          style={{ height: BOX_HEIGHT }}
        >
          <code>{html}</code>
        </pre>
      )}

      <Dialog open={fullscreen} onOpenChange={setFullscreen} size="lg" title={title}>
        <SandboxFrame srcDoc={srcDoc} title={title} height={DIALOG_FRAME_HEIGHT} lazy={false} />
      </Dialog>
    </div>
  );
}

/** 生成中：源码的最后几十行贴底显示，上沿淡出 */
function GeneratingTail({ html }: { html: string }) {
  const tail = tailLines(html, TAIL_LINES);
  return (
    <div className="flex flex-col">
      <div
        className="relative flex flex-col justify-end overflow-hidden bg-surface-sunken"
        style={{ height: BOX_HEIGHT - 40 }}
      >
        <pre className="shrink-0 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-ink-secondary">
          {tail.text}
        </pre>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-linear-to-b from-surface-sunken to-transparent"
        />
      </div>
      <p className="flex items-center gap-2 border-t border-line px-3 py-2 text-sm text-ink-secondary">
        <Spinner size="sm" label={null} />
        网页生成中，写完后自动预览
      </p>
    </div>
  );
}
