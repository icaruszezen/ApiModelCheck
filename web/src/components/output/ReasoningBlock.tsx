import { Accordion, AccordionItem, cn, Spinner } from "@endfield-ui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatNumber } from "../../lib/format";
import { countChars } from "./srcdoc";

export interface ReasoningBlockProps {
  /** 思考过程的全文 */
  text: string;
  /** 还在思考中（生成中且还没有正文）：展开并显示加载状态 */
  thinking?: boolean;
  className?: string;
}

const ITEM = "reasoning";

/**
 * 思考过程的折叠块：平时收起；正在思考时自动展开，开始出正文后自动收起。
 * 用户自己点过之后就不再自动开合。
 */
export function ReasoningBlock({ text, thinking = false, className }: ReasoningBlockProps) {
  const [open, setOpen] = useState(thinking);
  const touched = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    if (!touched.current) setOpen(thinking);
  }, [thinking]);

  // 思考过程不断变长时跟着滚到底；用户往上翻了就不跟
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && thinking && pinnedToBottom.current) node.scrollTop = node.scrollHeight;
  }, [text, thinking, open]);

  const count = formatNumber(countChars(text));

  return (
    <Accordion
      size="sm"
      level={4}
      className={className}
      value={open ? [ITEM] : []}
      onValueChange={(value) => {
        touched.current = true;
        setOpen(value.includes(ITEM));
      }}
    >
      <AccordionItem
        value={ITEM}
        title="思考过程"
        extra={
          thinking ? (
            <>
              <Spinner size="sm" label={null} />
              <span>思考中 · {count} 字</span>
            </>
          ) : (
            <span className="font-tech tabular-nums">{count} 字</span>
          )
        }
      >
        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label="思考过程"
          onScroll={(event) => {
            const node = event.currentTarget;
            pinnedToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
          className={cn(
            "max-h-80 overflow-y-auto text-sm break-words whitespace-pre-wrap text-ink-secondary",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          )}
        >
          {text || (thinking ? "正在思考…" : "")}
        </div>
      </AccordionItem>
    </Accordion>
  );
}
