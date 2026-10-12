import { describe, expect, it } from "vitest";
import {
  ADMIN_SECTIONS,
  adminDocumentTitle,
  DEFAULT_ADMIN_PATH,
  sectionFromPath,
} from "./shell-nav";

describe("sectionFromPath", () => {
  it("认出各栏目，包括末尾斜杠和更深的路径", () => {
    expect(sectionFromPath("/admin/models")).toBe("models");
    expect(sectionFromPath("/admin/channels/")).toBe("channels");
    expect(sectionFromPath("/admin/prompts/12")).toBe("prompts");
    expect(sectionFromPath("/admin/results")).toBe("results");
    expect(sectionFromPath("/admin/settings")).toBe("settings");
  });

  it("和路由一样不分大小写", () => {
    expect(sectionFromPath("/Admin/Channels")).toBe("channels");
  });

  it("认不出时返回 null", () => {
    expect(sectionFromPath("/admin")).toBeNull();
    expect(sectionFromPath("/admin/")).toBeNull();
    expect(sectionFromPath("/admin/promptsx")).toBeNull();
    expect(sectionFromPath("/admin/unknown")).toBeNull();
    expect(sectionFromPath("/models")).toBeNull();
    expect(sectionFromPath("/")).toBeNull();
  });
});

describe("栏目表", () => {
  it("五个栏目，路径都在 /admin 下，默认落在模型页", () => {
    expect(ADMIN_SECTIONS.map((section) => section.label)).toEqual([
      "模型",
      "渠道",
      "提示词",
      "检测记录",
      "设置",
    ]);
    for (const section of ADMIN_SECTIONS) {
      expect(sectionFromPath(section.path)).toBe(section.key);
    }
    expect(sectionFromPath(DEFAULT_ADMIN_PATH)).toBe("models");
  });

  it("浏览器标签上的标题", () => {
    expect(adminDocumentTitle("results")).toBe("检测记录 · 管理后台");
    expect(adminDocumentTitle(null)).toBe("管理后台");
  });
});
