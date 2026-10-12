import { describe, expect, it } from "vitest";
import type {
  AdminChannel,
  AdminModel,
  AdminPrompt,
} from "../../../../shared/types.ts";
import {
  buildModelInput,
  firstErrorField,
  modelToForm,
  modelToInput,
  newModelForm,
  normalizeNumberText,
  parseDecimal,
  parseInteger,
  splitInterval,
  toMinutes,
  validateModelForm,
  type ModelFormState,
} from "./model-form";

const NOW = "2026-10-11T00:00:00.000Z";

function channel(id: number, enabled = true): AdminChannel {
  return {
    id,
    name: `渠道 ${id}`,
    endpointType: "openai-chat",
    baseUrl: "",
    hasApiKey: false,
    apiKeyMasked: "",
    extraHeaders: {},
    enabled,
    sortOrder: 0,
    modelCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function prompt(id: number, enabled = true): AdminPrompt {
  return {
    id,
    title: `题 ${id}`,
    content: "内容",
    enabled,
    sortOrder: 0,
    modelIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function model(overrides: Partial<AdminModel> = {}): AdminModel {
  return {
    id: 7,
    channelId: 3,
    channelName: "渠道 3",
    model: "gpt-4o",
    displayName: "GPT-4o",
    stream: false,
    timeoutSeconds: 300,
    intervalMinutes: 2880,
    maxTokens: 4096,
    temperature: 0.7,
    enabled: true,
    sortOrder: -5,
    promptIds: [1, 2],
    lastRunAt: null,
    nextRunAt: null,
    running: false,
    lastStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function validForm(overrides: Partial<ModelFormState> = {}): ModelFormState {
  return {
    channelId: "1",
    model: "gpt-4o",
    displayName: "",
    promptIds: [1],
    stream: true,
    timeoutSeconds: "120",
    intervalValue: "1",
    intervalUnit: "hour",
    maxTokens: "",
    temperature: "",
    sortOrder: "0",
    enabled: true,
    ...overrides,
  };
}

describe("splitInterval / toMinutes", () => {
  it("取能整除的最大单位", () => {
    expect(splitInterval(1)).toEqual({ value: 1, unit: "minute" });
    expect(splitInterval(45)).toEqual({ value: 45, unit: "minute" });
    expect(splitInterval(60)).toEqual({ value: 1, unit: "hour" });
    expect(splitInterval(90)).toEqual({ value: 90, unit: "minute" });
    expect(splitInterval(180)).toEqual({ value: 3, unit: "hour" });
    expect(splitInterval(1440)).toEqual({ value: 1, unit: "day" });
    expect(splitInterval(2160)).toEqual({ value: 36, unit: "hour" });
    expect(splitInterval(10080)).toEqual({ value: 7, unit: "day" });
  });

  it("不合法的分钟数原样按分钟返回", () => {
    expect(splitInterval(0)).toEqual({ value: 0, unit: "minute" });
    expect(splitInterval(1.5)).toEqual({ value: 1.5, unit: "minute" });
  });

  it("换算回分钟", () => {
    expect(toMinutes(5, "minute")).toBe(5);
    expect(toMinutes(2, "hour")).toBe(120);
    expect(toMinutes(7, "day")).toBe(10080);
  });

  it("拆开再换算回来不变", () => {
    for (const minutes of [1, 59, 60, 61, 120, 1439, 1440, 4320, 10080]) {
      const { value, unit } = splitInterval(minutes);
      expect(toMinutes(value, unit)).toBe(minutes);
    }
  });
});

describe("数字解析", () => {
  it("全角数字和符号换成半角", () => {
    expect(normalizeNumberText(" １２０ ")).toBe("120");
    expect(normalizeNumberText("０．５")).toBe("0.5");
    expect(normalizeNumberText("－３")).toBe("-3");
  });

  it("parseInteger 只认整数", () => {
    expect(parseInteger("42")).toBe(42);
    expect(parseInteger(" -7 ")).toBe(-7);
    expect(parseInteger("１２")).toBe(12);
    expect(parseInteger("12.5")).toBeNaN();
    expect(parseInteger("1e3")).toBeNaN();
    expect(parseInteger("abc")).toBeNaN();
    expect(parseInteger("")).toBeNaN();
  });

  it("parseDecimal 认小数", () => {
    expect(parseDecimal("0.7")).toBe(0.7);
    expect(parseDecimal(".5")).toBe(0.5);
    expect(parseDecimal("2")).toBe(2);
    expect(parseDecimal("1.")).toBe(1);
    expect(parseDecimal("0x1")).toBeNaN();
    expect(parseDecimal("1,5")).toBeNaN();
    expect(parseDecimal("")).toBeNaN();
  });
});

describe("newModelForm", () => {
  it("默认流式、120 秒、每 1 小时，选中第一个启用的渠道和所有启用的提示词", () => {
    const form = newModelForm(
      [channel(4, false), channel(5), channel(6)],
      [prompt(1), prompt(2, false), prompt(3)],
    );
    expect(form).toMatchObject({
      channelId: "5",
      model: "",
      displayName: "",
      promptIds: [1, 3],
      stream: true,
      timeoutSeconds: "120",
      intervalValue: "1",
      intervalUnit: "hour",
      maxTokens: "",
      temperature: "",
      sortOrder: "0",
      enabled: true,
    });
  });

  it("渠道全都停用时选第一个；没有渠道时为空", () => {
    expect(
      newModelForm([channel(8, false), channel(9, false)], []).channelId,
    ).toBe("8");
    expect(newModelForm([], []).channelId).toBe("");
  });
});

describe("modelToForm / modelToInput", () => {
  it("把模型转成表单，间隔用最大的整除单位", () => {
    expect(modelToForm(model())).toEqual({
      channelId: "3",
      model: "gpt-4o",
      displayName: "GPT-4o",
      promptIds: [1, 2],
      stream: false,
      timeoutSeconds: "300",
      intervalValue: "2",
      intervalUnit: "day",
      maxTokens: "4096",
      temperature: "0.7",
      sortOrder: "-5",
      enabled: true,
    });
  });

  it("null 的可选字段变成空串", () => {
    const form = modelToForm(model({ maxTokens: null, temperature: null }));
    expect(form.maxTokens).toBe("");
    expect(form.temperature).toBe("");
  });

  it("表单原样提交回去得到同样的请求体", () => {
    const source = model();
    const built = buildModelInput(modelToForm(source));
    expect(built).toEqual({ ok: true, input: modelToInput(source) });
  });

  it("modelToInput 可以只改其中几项", () => {
    const input = modelToInput(model(), { enabled: false });
    expect(input.enabled).toBe(false);
    expect(input).toMatchObject({
      channelId: 3,
      model: "gpt-4o",
      intervalMinutes: 2880,
      promptIds: [1, 2],
    });
  });
});

describe("validateModelForm", () => {
  it("合法的表单没有错误", () => {
    expect(validateModelForm(validForm())).toEqual({});
  });

  it("渠道必选", () => {
    expect(validateModelForm(validForm({ channelId: "" })).channelId).toBe(
      "请选择渠道",
    );
  });

  it("模型 ID 去空白后 1 – 200 个字符", () => {
    expect(validateModelForm(validForm({ model: "   " })).model).toBe(
      "模型 ID 不能为空",
    );
    expect(validateModelForm(validForm({ model: "x".repeat(201) })).model).toBe(
      "模型 ID 不能超过 200 个字符",
    );
    expect(
      validateModelForm(validForm({ model: ` ${"x".repeat(200)} ` })).model,
    ).toBeUndefined();
  });

  it("显示名最多 100 个字符", () => {
    expect(
      validateModelForm(validForm({ displayName: "名".repeat(101) }))
        .displayName,
    ).toBe("显示名不能超过 100 个字符");
    expect(
      validateModelForm(validForm({ displayName: "名".repeat(100) }))
        .displayName,
    ).toBeUndefined();
  });

  it("超时时间 5 – 3600 的整数", () => {
    const message = "超时时间必须是 5 到 3600 之间的整数";
    expect(
      validateModelForm(validForm({ timeoutSeconds: "" })).timeoutSeconds,
    ).toBe("请填写超时时间");
    expect(
      validateModelForm(validForm({ timeoutSeconds: "4" })).timeoutSeconds,
    ).toBe(message);
    expect(
      validateModelForm(validForm({ timeoutSeconds: "3601" })).timeoutSeconds,
    ).toBe(message);
    expect(
      validateModelForm(validForm({ timeoutSeconds: "10.5" })).timeoutSeconds,
    ).toBe(message);
    expect(
      validateModelForm(validForm({ timeoutSeconds: "5" })).timeoutSeconds,
    ).toBeUndefined();
    expect(
      validateModelForm(validForm({ timeoutSeconds: "3600" })).timeoutSeconds,
    ).toBeUndefined();
  });

  it("检测间隔换算后在 1 分钟到 7 天之间", () => {
    const check = (
      intervalValue: string,
      intervalUnit: ModelFormState["intervalUnit"],
    ) => validateModelForm(validForm({ intervalValue, intervalUnit })).interval;
    expect(check("", "minute")).toBe("请填写检测间隔");
    expect(check("0", "minute")).toBe("检测间隔必须是正整数");
    expect(check("-1", "hour")).toBe("检测间隔必须是正整数");
    expect(check("1.5", "hour")).toBe("检测间隔必须是正整数");
    expect(check("1", "minute")).toBeUndefined();
    expect(check("10080", "minute")).toBeUndefined();
    expect(check("10081", "minute")).toBe("检测间隔必须在 1 分钟到 7 天之间");
    expect(check("168", "hour")).toBeUndefined();
    expect(check("169", "hour")).toBe("检测间隔必须在 1 分钟到 7 天之间");
    expect(check("7", "day")).toBeUndefined();
    expect(check("8", "day")).toBe("检测间隔必须在 1 分钟到 7 天之间");
  });

  it("最大输出 tokens 可以留空，否则 1 – 1000000 的整数", () => {
    const message = "最大输出 tokens 必须是 1 到 1000000 之间的整数";
    expect(
      validateModelForm(validForm({ maxTokens: "" })).maxTokens,
    ).toBeUndefined();
    expect(validateModelForm(validForm({ maxTokens: "0" })).maxTokens).toBe(
      message,
    );
    expect(
      validateModelForm(validForm({ maxTokens: "1000001" })).maxTokens,
    ).toBe(message);
    expect(
      validateModelForm(validForm({ maxTokens: "8192" })).maxTokens,
    ).toBeUndefined();
  });

  it("温度可以留空，否则 0 – 2", () => {
    const message = "温度必须是 0 到 2 之间的数字";
    expect(
      validateModelForm(validForm({ temperature: "" })).temperature,
    ).toBeUndefined();
    expect(
      validateModelForm(validForm({ temperature: "0" })).temperature,
    ).toBeUndefined();
    expect(
      validateModelForm(validForm({ temperature: "2" })).temperature,
    ).toBeUndefined();
    expect(
      validateModelForm(validForm({ temperature: "1.25" })).temperature,
    ).toBeUndefined();
    expect(
      validateModelForm(validForm({ temperature: "2.01" })).temperature,
    ).toBe(message);
    expect(
      validateModelForm(validForm({ temperature: "-0.1" })).temperature,
    ).toBe(message);
    expect(
      validateModelForm(validForm({ temperature: "高" })).temperature,
    ).toBe(message);
  });

  it("排序值留空按 0，否则 ±1000000 内的整数", () => {
    expect(
      validateModelForm(validForm({ sortOrder: "" })).sortOrder,
    ).toBeUndefined();
    expect(
      validateModelForm(validForm({ sortOrder: "-1000000" })).sortOrder,
    ).toBeUndefined();
    expect(
      validateModelForm(validForm({ sortOrder: "1000001" })).sortOrder,
    ).toBe("排序值必须是 -1000000 到 1000000 之间的整数");
  });

  it("firstErrorField 按表单顺序取第一个出错的字段", () => {
    const errors = validateModelForm(
      validForm({ model: "", temperature: "9", timeoutSeconds: "1" }),
    );
    expect(firstErrorField(errors)).toBe("model");
    expect(firstErrorField({})).toBeUndefined();
  });
});

describe("buildModelInput", () => {
  it("组装请求体：去空白、换算分钟、空的可选项为 null", () => {
    const built = buildModelInput(
      validForm({
        channelId: "2",
        model: "  claude-sonnet-4-5 ",
        displayName: "  Claude  ",
        promptIds: [3, 1, 3],
        stream: false,
        timeoutSeconds: "６００",
        intervalValue: "90",
        intervalUnit: "minute",
        maxTokens: "",
        temperature: "",
        sortOrder: "",
        enabled: false,
      }),
    );
    expect(built).toEqual({
      ok: true,
      input: {
        channelId: 2,
        model: "claude-sonnet-4-5",
        displayName: "Claude",
        stream: false,
        timeoutSeconds: 600,
        intervalMinutes: 90,
        maxTokens: null,
        temperature: null,
        enabled: false,
        sortOrder: 0,
        promptIds: [3, 1],
      },
    });
  });

  it("填了可选项时转成数字", () => {
    const built = buildModelInput(
      validForm({
        maxTokens: "8192",
        temperature: "0.3",
        intervalValue: "2",
        intervalUnit: "day",
      }),
    );
    expect(built.ok && built.input).toMatchObject({
      maxTokens: 8192,
      temperature: 0.3,
      intervalMinutes: 2880,
    });
  });

  it("有错误时不组装", () => {
    const built = buildModelInput(
      validForm({ model: "", intervalValue: "8", intervalUnit: "day" }),
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.errors).toEqual({
        model: "模型 ID 不能为空",
        interval: "检测间隔必须在 1 分钟到 7 天之间",
      });
    }
  });
});
