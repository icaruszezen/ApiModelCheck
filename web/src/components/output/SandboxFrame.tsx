import { cn } from "@endfield-ui/react";
import type { CSSProperties } from "react";
import { SANDBOX_POLICY } from "./srcdoc";

export interface SandboxFrameProps {
  /** 已经处理好的完整文档（见 buildSrcDoc） */
  srcDoc: string;
  /** iframe 的可访问名称 */
  title: string;
  /** CSS 高度，如 360 或 "80vh" */
  height: CSSProperties["height"];
  /** 不在视口里时先不加载；弹窗里的设为 false */
  lazy?: boolean;
  className?: string;
}

/**
 * 跑模型生成的网页的 iframe。内容只走 srcdoc，权限只有 allow-scripts（见 SANDBOX_POLICY）。
 * 底色固定白色、配色固定亮色：网页没写底色时，在暗色主题下也看得清。
 */
export function SandboxFrame({ srcDoc, title, height, lazy = true, className }: SandboxFrameProps) {
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox={SANDBOX_POLICY}
      referrerPolicy="no-referrer"
      loading={lazy ? "lazy" : "eager"}
      className={cn("block w-full border-0", className)}
      style={{ height, backgroundColor: "#fff", colorScheme: "light" }}
    />
  );
}
