// 占位：由输出展示模块实现
export interface OutputViewProps {
  /** 模型的正文输出（可能夹着 HTML 网页） */
  output: string;
  /** 上游单独返回的思考过程；正文开头的 <think>…</think> 也会被归到这里显示 */
  reasoning?: string;
  /** 还在生成中（流式的部分输出）：没写完的 HTML 先显示源码，写完了才渲染 */
  running?: boolean;
  /** 输出为空时显示的文字，默认"（没有输出）" */
  emptyText?: string;
  className?: string;
}

export function OutputView({ output, className }: OutputViewProps) {
  return <pre className={className}>{output}</pre>;
}
