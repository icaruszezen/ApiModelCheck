import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromptTabs } from "./PromptTabs";

function render(value: string): string {
  return renderToStaticMarkup(
    createElement(PromptTabs, {
      value,
      onValueChange: () => {},
      label: "检测题",
      items: [
        { value: "1", tab: "小数比较", panel: createElement("p", null, "面板一") },
        { value: "2", tab: "数字母", panel: createElement("p", null, "面板二") },
      ],
    }),
  );
}

function tags(markup: string, role: string): string[] {
  return markup.match(new RegExp(`<[a-z]+\\b[^>]*role="${role}"[^>]*>`, "g")) ?? [];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("PromptTabs", () => {
  it("页签栏、页签、面板的语义：选中的那个可以 Tab 进来，其余用方向键", () => {
    const markup = render("2");
    const [list] = tags(markup, "tablist");
    expect(attr(list ?? "", "aria-label")).toBe("检测题");

    const tabs = tags(markup, "tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => attr(tab, "aria-selected"))).toEqual(["false", "true"]);
    expect(tabs.map((tab) => attr(tab, "tabindex"))).toEqual(["-1", "0"]);
    expect(tabs.every((tab) => attr(tab, "type") === "button")).toBe(true);

    // 页签和面板互相指着对方
    const panels = tags(markup, "tabpanel");
    expect(panels).toHaveLength(2);
    tabs.forEach((tab, index) => {
      const panel = panels[index] ?? "";
      expect(attr(tab, "aria-controls")).toBe(attr(panel, "id"));
      expect(attr(panel, "aria-labelledby")).toBe(attr(tab, "id"));
    });
  });

  it("只渲染选中的面板，其余的藏起来、里面是空的", () => {
    const markup = render("1");
    expect(markup).toContain("面板一");
    expect(markup).not.toContain("面板二");
    const panels = tags(markup, "tabpanel");
    expect(panels.map((panel) => /\shidden=""/.test(panel))).toEqual([false, true]);
  });
});
