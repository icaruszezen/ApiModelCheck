import { describe, expect, it } from "vitest";
import type { AdminPrompt } from "../../../../shared/types.ts";
import {
  contentPreview,
  emptyPromptForm,
  modelOptionLabel,
  promptToForm,
  promptToggleInput,
  validatePromptForm,
  type PromptFormValues,
} from "./prompt-form";

const prompt: AdminPrompt = {
  id: 3,
  title: "网页时钟",
  content: "写一个单文件 HTML 页面。\n只输出完整的 HTML 代码。",
  enabled: true,
  sortOrder: 2,
  modelIds: [1, 4],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const form = (patch: Partial<PromptFormValues> = {}): PromptFormValues => ({
  ...emptyPromptForm(),
  title: "小数比较",
  content: "9.11 和 9.9 哪个大？",
  ...patch,
});

describe("validatePromptForm", () => {
  it("标题去空白，内容原样提交", () => {
    const result = validatePromptForm(
      form({ title: "  小数比较 ", content: "  9.11 和 9.9 哪个大？\n" }),
      { knownModelIds: new Set() },
    );
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      title: "小数比较",
      content: "  9.11 和 9.9 哪个大？\n",
      enabled: true,
      sortOrder: 0,
      modelIds: [],
    });
  });

  it("标题、内容、排序的错误", () => {
    const result = validatePromptForm(
      form({ title: "", content: " \n\t", sortOrder: "abc" }),
      { knownModelIds: null },
    );
    expect(result.input).toBeNull();
    expect(result.errors).toEqual({
      title: "标题不能为空",
      content: "内容不能为空",
      sortOrder: "排序值必须是 -1000000 到 1000000 之间的整数",
    });
  });

  it("长度上限：标题 100、内容 20000", () => {
    expect(
      validatePromptForm(form({ title: "题".repeat(101) }), {
        knownModelIds: null,
      }).errors.title,
    ).toBe("标题不能超过 100 个字符");
    expect(
      validatePromptForm(form({ content: "x".repeat(20001) }), {
        knownModelIds: null,
      }).errors.content,
    ).toBe("内容不能超过 20000 个字符");
    expect(
      validatePromptForm(form({ content: "x".repeat(20000) }), {
        knownModelIds: null,
      }).input,
    ).not.toBeNull();
  });

  it("只提交还存在的模型 id，去重", () => {
    const result = validatePromptForm(
      form({ modelIds: ["1", "4", "4", "9", "x"] }),
      { knownModelIds: new Set([1, 4, 5]) },
    );
    expect(result.input?.modelIds).toEqual([1, 4]);
  });

  it("模型列表没取到时不提交 modelIds，分配关系保持不变", () => {
    const result = validatePromptForm(promptToForm(prompt), {
      knownModelIds: null,
    });
    expect(result.input).not.toBeNull();
    expect(result.input && "modelIds" in result.input).toBe(false);
  });
});

describe("promptToForm / promptToggleInput", () => {
  it("模型 id 变成字符串给组合框用", () => {
    expect(promptToForm(prompt)).toEqual({
      title: "网页时钟",
      content: prompt.content,
      modelIds: ["1", "4"],
      sortOrder: "2",
      enabled: true,
    });
  });

  it("拨开关不带 modelIds", () => {
    const input = promptToggleInput(prompt, false);
    expect(input).toEqual({
      title: "网页时钟",
      content: prompt.content,
      enabled: false,
      sortOrder: 2,
    });
    expect("modelIds" in input).toBe(false);
  });
});

describe("显示", () => {
  it("预览把空白折成一个空格，太长截断", () => {
    expect(contentPreview("  第一行\n\n第二行\t结束  ")).toBe(
      "第一行 第二行 结束",
    );
    expect(contentPreview("a".repeat(10), 4)).toBe("aaaa…");
  });

  it("模型的名字：渠道名 / 显示名或模型 ID", () => {
    expect(
      modelOptionLabel({
        channelName: "官方",
        displayName: "",
        model: "gpt-5",
        enabled: true,
      }),
    ).toBe("官方 / gpt-5");
    expect(
      modelOptionLabel({
        channelName: "中转",
        displayName: "Claude",
        model: "claude-x",
        enabled: false,
      }),
    ).toBe("中转 / Claude（已停用）");
  });
});
