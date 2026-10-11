import { describe, expect, it } from "vitest";
import { formatNumber } from "../../lib/format";
import {
  isLongText,
  isResultStatus,
  pageCountOf,
  parseResultsQuery,
  resultsQueryToParams,
  tokensText,
  withFilter,
} from "./result-query";

describe("parseResultsQuery", () => {
  it("解析合法的参数", () => {
    expect(
      parseResultsQuery(
        new URLSearchParams("modelId=3&promptId=12&status=timeout&page=4"),
      ),
    ).toEqual({ modelId: 3, promptId: 12, status: "timeout", page: 4 });
  });

  it("没有参数时是第 1 页、不筛选", () => {
    expect(parseResultsQuery(new URLSearchParams(""))).toEqual({
      modelId: undefined,
      promptId: undefined,
      status: undefined,
      page: 1,
    });
  });

  it("不合法的值当作没传", () => {
    expect(
      parseResultsQuery(
        new URLSearchParams("modelId=abc&promptId=-1&status=done&page=0"),
      ),
    ).toEqual({
      modelId: undefined,
      promptId: undefined,
      status: undefined,
      page: 1,
    });
    expect(
      parseResultsQuery(new URLSearchParams("modelId=1.5&page=2x")).modelId,
    ).toBeUndefined();
    expect(
      parseResultsQuery(new URLSearchParams("modelId=99999999999999999999"))
        .modelId,
    ).toBeUndefined();
  });
});

describe("resultsQueryToParams", () => {
  it("第 1 页不写 page，空的条件不写", () => {
    expect(resultsQueryToParams({ page: 1 }).toString()).toBe("");
    expect(
      resultsQueryToParams({ modelId: 3, status: "error", page: 1 }).toString(),
    ).toBe("modelId=3&status=error");
    expect(resultsQueryToParams({ promptId: 2, page: 5 }).toString()).toBe(
      "promptId=2&page=5",
    );
  });

  it("和 parseResultsQuery 互逆", () => {
    const query = {
      modelId: 8,
      promptId: 9,
      status: "running" as const,
      page: 3,
    };
    expect(parseResultsQuery(resultsQueryToParams(query))).toEqual(query);
  });
});

describe("withFilter", () => {
  it("改筛选条件时回到第 1 页", () => {
    expect(withFilter({ modelId: 1, page: 6 }, { status: "success" })).toEqual({
      modelId: 1,
      status: "success",
      page: 1,
    });
  });

  it("可以清掉某个条件", () => {
    expect(withFilter({ modelId: 1, page: 2 }, { modelId: undefined })).toEqual(
      {
        modelId: undefined,
        page: 1,
      },
    );
  });
});

describe("pageCountOf", () => {
  it("至少 1 页", () => {
    expect(pageCountOf(0, 20)).toBe(1);
    expect(pageCountOf(20, 20)).toBe(1);
    expect(pageCountOf(21, 20)).toBe(2);
    expect(pageCountOf(Number.NaN, 20)).toBe(1);
  });
});

describe("isResultStatus", () => {
  it("只认四种状态", () => {
    expect(isResultStatus("success")).toBe(true);
    expect(isResultStatus("running")).toBe(true);
    expect(isResultStatus("all")).toBe(false);
    expect(isResultStatus(null)).toBe(false);
  });
});

describe("tokensText", () => {
  it("输入 / 输出", () => {
    expect(tokensText(1234, 56, formatNumber)).toBe("1,234 / 56");
    expect(tokensText(null, 56, formatNumber)).toBe("— / 56");
    expect(tokensText(null, null, formatNumber)).toBe("—");
  });
});

describe("isLongText", () => {
  it("超过行数或字数时算长", () => {
    expect(isLongText("短")).toBe(false);
    expect(isLongText("1\n2\n3\n4\n5\n6")).toBe(false);
    expect(isLongText("1\n2\n3\n4\n5\n6\n7")).toBe(true);
    expect(isLongText("字".repeat(401))).toBe(true);
    expect(isLongText("字".repeat(400))).toBe(false);
  });
});
