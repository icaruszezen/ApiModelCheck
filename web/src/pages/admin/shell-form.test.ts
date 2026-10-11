import { describe, expect, it } from "vitest";
import {
  compactErrors,
  hasErrors,
  parseIntInRange,
  parseSortOrder,
  textError,
} from "./shell-form";

describe("parseIntInRange", () => {
  it("接受带空白和正负号的整数", () => {
    expect(parseIntInRange(" 42 ", 0, 100)).toBe(42);
    expect(parseIntInRange("+7", 0, 100)).toBe(7);
    expect(parseIntInRange("-5", -10, 10)).toBe(-5);
    expect(Object.is(parseIntInRange("-0", -10, 10), 0)).toBe(true);
  });

  it("拒绝小数、科学计数法、空串和超出范围的值", () => {
    for (const text of ["", " ", "1.5", "1e3", "abc", "0x10", "١٢"]) {
      expect(parseIntInRange(text, -1000, 1000)).toBeNull();
    }
    expect(parseIntInRange("0", 1, 10)).toBeNull();
    expect(parseIntInRange("11", 1, 10)).toBeNull();
    expect(
      parseIntInRange("99999999999999999", 0, Number.MAX_VALUE),
    ).toBeNull();
  });
});

describe("parseSortOrder", () => {
  it("留空当 0，范围是 ±1000000", () => {
    expect(parseSortOrder("")).toBe(0);
    expect(parseSortOrder("-1000000")).toBe(-1_000_000);
    expect(parseSortOrder("1000001")).toBeNull();
  });
});

describe("textError / compactErrors", () => {
  it("先去首尾空白再判断", () => {
    expect(textError("名称", "  ", 10, true)).toBe("名称不能为空");
    expect(textError("名称", "  ", 10, false)).toBeUndefined();
    expect(textError("名称", " 12345678901 ", 10, true)).toBe(
      "名称不能超过 10 个字符",
    );
    expect(textError("名称", " 1234567890 ", 10, true)).toBeUndefined();
  });

  it("只留下真的出错的字段", () => {
    const errors = compactErrors<"a" | "b" | "c">({
      a: undefined,
      b: "错",
      c: "",
    });
    expect(errors).toEqual({ b: "错" });
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors({ a: undefined })).toBe(false);
  });
});
