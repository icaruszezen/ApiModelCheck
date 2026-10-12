import { afterEach, describe, expect, it, vi } from "vitest";
import { stickyEndHeadRef } from "./sticky-end";

/** 测试环境没有 DOM：拿最小的假对象顶上表头格和滚动容器 */
function fakeTable(width: number) {
  const style = new Map<string, string>();
  const scroller = {
    style: {
      setProperty: (name: string, value: string) => style.set(name, value),
      removeProperty: (name: string) => style.delete(name),
    },
  };
  const cell = {
    offsetWidth: width,
    closest: (selector: string) =>
      selector === "table" ? { parentElement: scroller } : null,
  };
  return { cell: cell as unknown as HTMLTableCellElement, raw: cell, style };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stickyEndHeadRef", () => {
  it("滚动容器右侧的 scroll-padding 等于操作列宽度再留一点空，列宽变了跟着改，卸下时清掉", () => {
    let onResize: (() => void) | undefined;
    const observed: unknown[] = [];
    let disconnected = false;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe(target: unknown) {
          observed.push(target);
        }
        disconnect() {
          disconnected = true;
        }
      },
    );
    const { cell, raw, style } = fakeTable(133);
    const cleanup = stickyEndHeadRef(cell);
    expect(style.get("scroll-padding-inline-end")).toBe("141px");
    expect(observed).toEqual([cell]);

    // "测试连接"变成"测试中"之类，列宽变了
    raw.offsetWidth = 185;
    onResize?.();
    expect(style.get("scroll-padding-inline-end")).toBe("193px");

    cleanup?.();
    expect(disconnected).toBe(true);
    expect(style.has("scroll-padding-inline-end")).toBe(false);
  });

  it("没有 ResizeObserver 时只量一次", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { cell, style } = fakeTable(61);
    expect(stickyEndHeadRef(cell)).toBeUndefined();
    expect(style.get("scroll-padding-inline-end")).toBe("69px");
  });

  it("卸下时（null）、找不到表格时什么也不做", () => {
    expect(stickyEndHeadRef(null)).toBeUndefined();
    const orphan = {
      offsetWidth: 100,
      closest: () => null,
    } as unknown as HTMLTableCellElement;
    expect(stickyEndHeadRef(orphan)).toBeUndefined();
  });
});
