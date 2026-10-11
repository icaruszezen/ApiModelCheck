/**
 * 直接喂各家适配器构造好的响应 / 事件，覆盖模拟上游不会产生的分支。
 */
import { describe, expect, it } from "vitest";
import { anthropic } from "./anthropic.ts";
import { gemini } from "./gemini.ts";
import { OutputBuilder, errorMessageFrom } from "./http.ts";
import type { JsonObject, ProviderAdapter } from "./http.ts";
import { openaiChat } from "./openai-chat.ts";
import { openaiResponses } from "./openai-responses.ts";
import { ProviderError } from "./types.ts";
import type { CompletionDelta } from "./types.ts";

function feed(
  adapter: ProviderAdapter,
  events: (JsonObject | [string, JsonObject])[],
) {
  const deltas: CompletionDelta[] = [];
  const out = new OutputBuilder((delta) => deltas.push(delta));
  const handler = adapter.createStreamHandler(out);
  let done = false;
  for (const item of events) {
    const [name, data] = Array.isArray(item) ? item : ["", item];
    if (handler.onEvent(data, name)) {
      done = true;
      break;
    }
  }
  handler.finish?.();
  return { result: out.result(), deltas, done };
}

function joined(deltas: CompletionDelta[], key: keyof CompletionDelta): string {
  return deltas.map((delta) => delta[key] ?? "").join("");
}

describe("errorMessageFrom", () => {
  it("按 error.message、error、message、detail 的顺序找", () => {
    expect(errorMessageFrom({ error: { message: "a" }, message: "b" })).toBe(
      "a",
    );
    expect(errorMessageFrom({ error: "b", message: "c" })).toBe("b");
    expect(errorMessageFrom({ message: "c", detail: "d" })).toBe("c");
    expect(errorMessageFrom({ detail: "d" })).toBe("d");
    expect(errorMessageFrom({ error: { code: 1 } })).toBeNull();
    expect(errorMessageFrom("x")).toBeNull();
    expect(errorMessageFrom(null)).toBeNull();
  });
});

describe("openai-chat", () => {
  it("非流式：content 分段数组、reasoning 字段", () => {
    const result = openaiChat.parseResponse({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "答案" },
              { type: "text", text: "是 9.9" },
            ],
            reasoning: "想了一下",
          },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 7 },
    });
    expect(result).toEqual({
      output: "答案是 9.9",
      reasoning: "想了一下",
      inputTokens: 3,
      outputTokens: 7,
      finishReason: "length",
    });
  });

  it("非流式：正文为空时用 refusal", () => {
    const result = openaiChat.parseResponse({
      choices: [
        {
          message: { content: null, refusal: "I can't help with that." },
          finish_reason: "stop",
        },
      ],
    });
    expect(result.output).toBe("I can't help with that.");
    expect(result.inputTokens).toBeNull();
  });

  it("非流式：Mistral 风格的 thinking 段", () => {
    const result = openaiChat.parseResponse({
      choices: [
        {
          message: {
            content: [
              { type: "thinking", thinking: [{ type: "text", text: "推理" }] },
              { type: "text", text: "结论" },
            ],
          },
        },
      ],
    });
    expect(result.reasoning).toBe("推理");
    expect(result.output).toBe("结论");
  });

  it("流式：数据里出现 error 对象时抛出", () => {
    expect(() =>
      feed(openaiChat, [
        { choices: [{ delta: { content: "a" } }] },
        { error: { message: "rate limited" } },
      ]),
    ).toThrow(new ProviderError("rate limited"));
  });

  it("流式：reasoning 字段、refusal 增量、每块都带 usage", () => {
    const { result, deltas } = feed(openaiChat, [
      { choices: [{ delta: { reasoning: "思考" } }], usage: null },
      {
        choices: [{ delta: { content: "正文" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        choices: [{ delta: { refusal: "拒绝" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 3 },
      },
    ]);
    expect(result).toEqual({
      output: "正文拒绝",
      reasoning: "思考",
      inputTokens: 1,
      outputTokens: 3,
      finishReason: "stop",
    });
    expect(deltas).toEqual([
      { reasoning: "思考" },
      { output: "正文" },
      { output: "拒绝" },
    ]);
  });

  it("流式：error 为 null 的块照常处理", () => {
    const { result } = feed(openaiChat, [
      { error: null, choices: [{ delta: { content: "ok" } }] },
    ]);
    expect(result.output).toBe("ok");
  });
});

describe("openai-responses", () => {
  it("非流式：refusal 算正文，推理摘要多段用空行隔开，incomplete 取具体原因", () => {
    const result = openaiResponses.parseResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "第一段" },
            { type: "summary_text", text: "第二段" },
          ],
        },
        {
          type: "message",
          content: [
            { type: "output_text", text: "部分" },
            { type: "refusal", refusal: "拒绝" },
          ],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 9 },
    });
    expect(result).toEqual({
      output: "部分拒绝",
      reasoning: "第一段\n\n第二段",
      inputTokens: 5,
      outputTokens: 9,
      finishReason: "max_output_tokens",
    });
  });

  it("非流式：status failed 抛出 error.message", () => {
    expect(() =>
      openaiResponses.parseResponse({
        status: "failed",
        output: [],
        error: { code: "server_error", message: "boom" },
      }),
    ).toThrow(new ProviderError("boom"));
  });

  it("非流式：开源实现的 reasoning_text", () => {
    const result = openaiResponses.parseResponse({
      status: "completed",
      output: [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "原文推理" }],
        },
      ],
    });
    expect(result.reasoning).toBe("原文推理");
    expect(result.finishReason).toBe("completed");
  });

  it("流式：换一段摘要时用空行隔开，和非流式一致", () => {
    const { result, deltas, done } = feed(openaiResponses, [
      [
        "response.reasoning_summary_text.delta",
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs",
          summary_index: 0,
          delta: "第一",
        },
      ],
      [
        "response.reasoning_summary_text.delta",
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs",
          summary_index: 0,
          delta: "段",
        },
      ],
      [
        "response.reasoning_summary_text.delta",
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs",
          summary_index: 1,
          delta: "第二段",
        },
      ],
      [
        "response.refusal.delta",
        { type: "response.refusal.delta", delta: "不" },
      ],
      [
        "response.output_text.delta",
        { type: "response.output_text.delta", delta: "行" },
      ],
      [
        "response.incomplete",
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ],
      [
        "response.output_text.delta",
        { type: "response.output_text.delta", delta: "结束后的内容不应出现" },
      ],
    ]);
    expect(done).toBe(true);
    expect(result).toEqual({
      output: "不行",
      reasoning: "第一段\n\n第二段",
      inputTokens: 1,
      outputTokens: 2,
      finishReason: "content_filter",
    });
    expect(joined(deltas, "reasoning")).toBe(result.reasoning);
  });

  it("流式：没有增量、只在 completed 里给完整输出", () => {
    const { result, deltas } = feed(openaiResponses, [
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            { type: "reasoning", summary: [{ text: "推理" }] },
            {
              type: "message",
              content: [{ type: "output_text", text: "全文" }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]);
    expect(result.output).toBe("全文");
    expect(result.reasoning).toBe("推理");
    expect(deltas).toEqual([{ reasoning: "推理" }, { output: "全文" }]);
  });

  it("流式：已经有增量时 completed 里的输出不重复计入", () => {
    const { result } = feed(openaiResponses, [
      { type: "response.output_text.delta", delta: "全文" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "全文" }],
            },
          ],
        },
      },
    ]);
    expect(result.output).toBe("全文");
  });

  it("流式：error 事件与 response.failed", () => {
    expect(() =>
      feed(openaiResponses, [
        ["error", { type: "error", code: "rate_limit", message: "slow down" }],
      ]),
    ).toThrow(new ProviderError("slow down"));
    expect(() =>
      feed(openaiResponses, [{ type: "error", error: { message: "nested" } }]),
    ).toThrow(new ProviderError("nested"));
    expect(() =>
      feed(openaiResponses, [
        {
          type: "response.failed",
          response: { status: "failed", error: { message: "model crashed" } },
        },
      ]),
    ).toThrow(new ProviderError("model crashed"));
    expect(() =>
      feed(openaiResponses, [
        {
          type: "response.failed",
          response: { status: "failed", error: null },
        },
      ]),
    ).toThrow(new ProviderError("上游报告生成失败"));
  });

  it("流式：data 里没有 type 时看 event 名", () => {
    const { result } = feed(openaiResponses, [
      ["response.output_text.delta", { delta: "x" }],
    ]);
    expect(result.output).toBe("x");
  });
});

describe("anthropic", () => {
  const blocks = [
    { type: "thinking", thinking: "第一块", signature: "s" },
    { type: "redacted_thinking", data: "xxx" },
    { type: "thinking", thinking: "第二块", signature: "s" },
    { type: "text", text: "正文A" },
    { type: "text", text: "正文B" },
  ];

  it("非流式：多个 thinking 块用空行隔开，输入 tokens 加上缓存部分", () => {
    const result = anthropic.parseResponse({
      type: "message",
      content: blocks,
      stop_reason: "max_tokens",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 100,
        output_tokens: 20,
      },
    });
    expect(result).toEqual({
      output: "正文A正文B",
      reasoning: "第一块\n\n第二块",
      inputTokens: 115,
      outputTokens: 20,
      finishReason: "max_tokens",
    });
  });

  it("非流式：type 为 error 的响应", () => {
    expect(() =>
      anthropic.parseResponse({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    ).toThrow(new ProviderError("Overloaded"));
  });

  it("流式：与非流式拼出同样的结果；message_delta 里的累计用量覆盖之前的", () => {
    const events: JsonObject[] = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            output_tokens: 1,
          },
        },
      },
      { type: "ping" },
    ];
    blocks.forEach((block, index) => {
      if (block.type === "thinking") {
        events.push({
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: "s" },
        });
      } else if (block.type === "text") {
        events.push({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        });
      } else {
        events.push({
          type: "content_block_start",
          index,
          content_block: block,
        });
      }
      events.push({ type: "content_block_stop", index });
    });
    events.push({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 12, output_tokens: 30 },
    });
    events.push({ type: "message_stop" });
    const { result, deltas, done } = feed(anthropic, events);
    expect(done).toBe(true);
    // message_delta 只更新了 input_tokens，缓存命中的 100 沿用 message_start 的
    expect(result).toEqual({
      output: "正文A正文B",
      reasoning: "第一块\n\n第二块",
      inputTokens: 112,
      outputTokens: 30,
      finishReason: "end_turn",
    });
    expect(joined(deltas, "reasoning")).toBe(result.reasoning);
    expect(joined(deltas, "output")).toBe(result.output);
  });

  it("流式：error 事件", () => {
    expect(() =>
      feed(anthropic, [
        [
          "error",
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ],
      ]),
    ).toThrow(new ProviderError("Overloaded"));
  });
});

describe("gemini", () => {
  it("非流式：thought 段是思考过程，输出 tokens 加上思考部分", () => {
    const result = gemini.parseResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: "想", thought: true },
              { text: "法", thought: true },
              { text: "答案" },
              { thoughtSignature: "x" },
            ],
          },
          finishReason: "MAX_TOKENS",
        },
      ],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 6,
        thoughtsTokenCount: 10,
      },
    });
    expect(result).toEqual({
      output: "答案",
      reasoning: "想法",
      inputTokens: 4,
      outputTokens: 16,
      finishReason: "MAX_TOKENS",
    });
  });

  it("非流式：没有候选且被拦截", () => {
    expect(() =>
      gemini.parseResponse({ promptFeedback: { blockReason: "SAFETY" } }),
    ).toThrow(new ProviderError("请求被拦截：SAFETY"));
  });

  it("非流式：响应块数组（不带 alt=sse 的流式接口）", () => {
    const result = gemini.parseResponse([
      {
        candidates: [{ content: { parts: [{ text: "a" }] } }],
        usageMetadata: { promptTokenCount: 2 },
      },
      {
        candidates: [
          { content: { parts: [{ text: "b" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2 },
      },
    ]);
    expect(result).toEqual({
      output: "ab",
      reasoning: "",
      inputTokens: 2,
      outputTokens: 2,
      finishReason: "STOP",
    });
  });

  it("非流式：错误对象与认不出的结构", () => {
    expect(() =>
      gemini.parseResponse({
        error: { code: 429, message: "Resource exhausted" },
      }),
    ).toThrow(new ProviderError("Resource exhausted"));
    expect(() => gemini.parseResponse({ foo: 1 })).toThrow(/格式无法识别/);
    expect(() => gemini.parseResponse([])).toThrow(/格式无法识别/);
  });

  it("流式：用量取最后一个带 usageMetadata 的块；块里的错误抛出", () => {
    const { result } = feed(gemini, [
      {
        candidates: [{ content: { parts: [{ text: "x" }] } }],
        usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
      },
      {
        candidates: [
          { content: { parts: [{ text: "y" }] }, finishReason: "STOP" },
        ],
      },
    ]);
    expect(result).toEqual({
      output: "xy",
      reasoning: "",
      inputTokens: 3,
      outputTokens: null,
      finishReason: "STOP",
    });
    expect(() =>
      feed(gemini, [{ error: { code: 500, message: "internal" } }]),
    ).toThrow(new ProviderError("internal"));
    expect(() =>
      feed(gemini, [{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }]),
    ).toThrow(new ProviderError("请求被拦截：PROHIBITED_CONTENT"));
  });
});
