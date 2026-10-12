import { describe, expect, it } from "vitest";
import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("没有值时是破折号", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("一秒以内写毫秒", () => {
    expect(formatDuration(0)).toBe("0 毫秒");
    expect(formatDuration(999)).toBe("999 毫秒");
    // 舍入后满一秒的不写成"1000 毫秒"
    expect(formatDuration(999.7)).toBe("1.0 秒");
  });

  it("一分钟以内写到 0.1 秒", () => {
    expect(formatDuration(1000)).toBe("1.0 秒");
    expect(formatDuration(1234)).toBe("1.2 秒");
    expect(formatDuration(59_949)).toBe("59.9 秒");
  });

  it("舍入后满一分钟的进到分，不写成 60.0 秒", () => {
    expect(formatDuration(59_950)).toBe("1 分");
    expect(formatDuration(59_960)).toBe("1 分");
    expect(formatDuration(60_000)).toBe("1 分");
  });

  it("秒数舍入到 60 时进位，不写成 N 分 60 秒", () => {
    expect(formatDuration(65_000)).toBe("1 分 5 秒");
    expect(formatDuration(119_400)).toBe("1 分 59 秒");
    expect(formatDuration(119_500)).toBe("2 分");
    expect(formatDuration(119_600)).toBe("2 分");
    expect(formatDuration(179_700)).toBe("3 分");
    expect(formatDuration(3_599_600)).toBe("60 分");
  });

  it("整分钟只写分", () => {
    expect(formatDuration(120_000)).toBe("2 分");
    expect(formatDuration(125_000)).toBe("2 分 5 秒");
  });
});
