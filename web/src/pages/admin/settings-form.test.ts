import { describe, expect, it } from "vitest";
import type { Settings } from "../../../../shared/types.ts";
import {
  isSettingsDirty,
  settingsToForm,
  validateSettingsForm,
} from "./settings-form";

const saved: Settings = {
  siteTitle: "模型智商检测",
  siteDescription: "定时向各家大模型发出同一组检测题。",
  retentionPerCheck: 20,
  maxConcurrency: 2,
};

describe("validateSettingsForm", () => {
  it("合法的值转成请求体，文字去空白", () => {
    const result = validateSettingsForm({
      siteTitle: "  新标题 ",
      siteDescription: "  ",
      retentionPerCheck: " 50 ",
      maxConcurrency: "20",
    });
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      siteTitle: "新标题",
      siteDescription: "",
      retentionPerCheck: 50,
      maxConcurrency: 20,
    });
  });

  it("每个字段的错误与服务端措辞一致", () => {
    const result = validateSettingsForm({
      siteTitle: "",
      siteDescription: "说".repeat(501),
      retentionPerCheck: "0",
      maxConcurrency: "2.5",
    });
    expect(result.input).toBeNull();
    expect(result.errors).toEqual({
      siteTitle: "站点标题不能为空",
      siteDescription: "站点说明不能超过 500 个字符",
      retentionPerCheck: "保留条数必须是 1 到 1000 之间的整数",
      maxConcurrency: "同时检测数必须是 1 到 20 之间的整数",
    });
  });

  it("上限边界", () => {
    expect(
      validateSettingsForm({
        ...settingsToForm(saved),
        retentionPerCheck: "1001",
        maxConcurrency: "21",
        siteTitle: "标".repeat(101),
      }).errors,
    ).toEqual({
      siteTitle: "站点标题不能超过 100 个字符",
      retentionPerCheck: "保留条数必须是 1 到 1000 之间的整数",
      maxConcurrency: "同时检测数必须是 1 到 20 之间的整数",
    });
    expect(
      validateSettingsForm({
        ...settingsToForm(saved),
        retentionPerCheck: "1000",
        maxConcurrency: "1",
      }).input,
    ).not.toBeNull();
  });
});

describe("isSettingsDirty", () => {
  it("和上次保存的值比", () => {
    expect(isSettingsDirty(settingsToForm(saved), saved)).toBe(false);
    expect(
      isSettingsDirty({ ...settingsToForm(saved), maxConcurrency: "3" }, saved),
    ).toBe(true);
    expect(
      isSettingsDirty({ ...settingsToForm(saved), siteTitle: "x" }, saved),
    ).toBe(true);
  });
});
