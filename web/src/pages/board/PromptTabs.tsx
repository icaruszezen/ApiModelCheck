import { cn } from "@endfield-ui/react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

export interface PromptTabItem {
  value: string;
  /** 页签上的内容（记号、标题、读屏文字） */
  tab: ReactNode;
  /** 选中时面板里的内容；没选中的面板只留一个空容器 */
  panel: ReactNode;
}

export interface PromptTabsProps {
  value: string;
  onValueChange: (value: string) => void;
  /** 页签栏的可访问名称 */
  label: string;
  items: readonly PromptTabItem[];
  /** 页签栏外层（左右内边距、下面的细线在这里） */
  listClassName?: string;
  panelClassName?: string;
}

/** 页签栏外层：下面一条细线 */
export const TAB_LIST = "border-b border-line";

/**
 * 一个页签的样子。只有一道题时卡片上没有页签，题目标题照选中的页签画，同一排卡片对得齐。
 * 选中的墨线画在里面贴底，压在外层那条细线上面
 */
export function tabClass(selected: boolean): string {
  return cn(
    "relative inline-flex h-10 min-w-0 items-center gap-1.5 text-sm",
    "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:content-['']",
    selected
      ? "font-medium text-ink after:bg-ink forced-colors:after:bg-[Highlight]"
      : "text-ink-secondary hover:text-ink",
  );
}

/** 页签值拼进 id 之前换掉不能出现在 IDREF 里的字符 */
const toId = (base: string, kind: "tab" | "panel", value: string) =>
  `${base}-${kind}-${value.replace(/[^\w-]/g, "_")}`;

/**
 * 卡片里切换检测题的页签：小号文字，选中的那个下面一条墨线。语义和键盘操作照组件库的 Tabs：
 * tablist / tab / tabpanel，漫游 tabindex，方向键和 Home / End 直接切换，面板可以聚焦。
 * 放不下时折行，不横向滚动：每道题的状态记号都看得见
 */
export function PromptTabs({
  value,
  onValueChange,
  label,
  items,
  listClassName,
  panelClassName,
}: PromptTabsProps) {
  const baseId = useId();
  // 一开始选中的那块面板不动，切过来的才淡入
  const [initial] = useState(value);
  const [switched, setSwitched] = useState(false);
  if (!switched && value !== initial) setSwitched(true);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  return (
    <>
      <div className={cn(TAB_LIST, listClassName)}>
        <div
          role="tablist"
          aria-label={label}
          aria-orientation="horizontal"
          onKeyDown={handleKeyDown}
          className="flex flex-wrap gap-x-5"
        >
          {items.map((item) => {
            const selected = item.value === value;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                id={toId(baseId, "tab", item.value)}
                aria-selected={selected}
                aria-controls={toId(baseId, "panel", item.value)}
                tabIndex={selected ? 0 : -1}
                onClick={() => onValueChange(item.value)}
                className={cn(
                  tabClass(selected),
                  "max-w-full transition-colors duration-(--duration-fast) ease-standard",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
                )}
              >
                {item.tab}
              </button>
            );
          })}
        </div>
      </div>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <div
            key={item.value}
            role="tabpanel"
            id={toId(baseId, "panel", item.value)}
            aria-labelledby={toId(baseId, "tab", item.value)}
            hidden={!selected}
            tabIndex={0}
            className={cn(
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
              selected && switched && "animate-fade-in",
              panelClassName,
            )}
          >
            {selected ? item.panel : null}
          </div>
        );
      })}
    </>
  );
}
