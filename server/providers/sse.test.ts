import { describe, expect, it } from "vitest";
import { SseParser, readSseStream } from "./sse.ts";
import type { SseEvent } from "./sse.ts";

function parseAll(chunks: string[]): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.feed(chunk));
  events.push(...parser.end());
  return events;
}

async function collect(chunks: Uint8Array[]): Promise<SseEvent[]> {
  async function* source() {
    for (const chunk of chunks) yield chunk;
  }
  const events: SseEvent[] = [];
  for await (const event of readSseStream(source())) events.push(event);
  return events;
}

/** 一段覆盖各种情况的 SSE 文本：CRLF / CR / LF 混用、注释、事件名、多行 data、中文和 emoji */
const SAMPLE =
  ": 开头的注释\r\n" +
  "event: message_start\r\n" +
  'data: {"type":"message_start"}\r\n' +
  "\r\n" +
  "data: 第一行\r" +
  "data: 第二行 🎉\r" +
  "\r" +
  "event: ping\n" +
  "id: 7\n" +
  "retry: 1000\n" +
  "data:没有空格\n" +
  "\n" +
  "data\n" +
  "\n" +
  "event: only-name\n" +
  "\n" +
  "data: [DONE]\n" +
  "\n";

const SAMPLE_EVENTS: SseEvent[] = [
  { event: "message_start", data: '{"type":"message_start"}' },
  { event: "", data: "第一行\n第二行 🎉" },
  { event: "ping", data: "没有空格" },
  { event: "", data: "" },
  { event: "", data: "[DONE]" },
];

describe("SseParser", () => {
  it("一次喂入完整文本", () => {
    expect(parseAll([SAMPLE])).toEqual(SAMPLE_EVENTS);
  });

  it("任意位置切开（逐字符喂入）结果不变", () => {
    expect(parseAll(Array.from(SAMPLE))).toEqual(SAMPLE_EVENTS);
  });

  it("每种切分位置都不影响结果", () => {
    for (let i = 1; i < SAMPLE.length; i++) {
      expect(parseAll([SAMPLE.slice(0, i), SAMPLE.slice(i)])).toEqual(
        SAMPLE_EVENTS,
      );
    }
  });

  it("\\r\\n 被切在两段之间时不会多出一个空行", () => {
    expect(parseAll(["data: a\r", "\ndata: b\r", "\n\r", "\n"])).toEqual([
      { event: "", data: "a\nb" },
    ]);
  });

  it("单独的 \\r 也算换行", () => {
    expect(parseAll(["data: a\r\rdata: b\r\r"])).toEqual([
      { event: "", data: "a" },
      { event: "", data: "b" },
    ]);
  });

  it("流结束时分发没跟空行的最后一个事件", () => {
    expect(parseAll(["event: tail\ndata: 最后", "一段"])).toEqual([
      { event: "tail", data: "最后一段" },
    ]);
    expect(parseAll(["data: x\n"])).toEqual([{ event: "", data: "x" }]);
  });

  it("只有注释或事件名、没有 data 的块不分发", () => {
    expect(parseAll([": keep-alive\n\nevent: x\n\n"])).toEqual([]);
  });

  it("只去掉冒号后的一个空格", () => {
    expect(parseAll(["data:  两个空格\n\n"])).toEqual([
      { event: "", data: " 两个空格" },
    ]);
  });

  it("事件名不会带到下一个事件", () => {
    expect(parseAll(["event: a\ndata: 1\n\ndata: 2\n\n"])).toEqual([
      { event: "a", data: "1" },
      { event: "", data: "2" },
    ]);
  });
});

describe("readSseStream", () => {
  it("UTF-8 字符被切在两个字节块之间时正确解码", async () => {
    const bytes = new TextEncoder().encode(SAMPLE);
    // 逐字节喂入：每个多字节字符都被切开
    const single = Array.from(bytes, (byte) => Uint8Array.of(byte));
    expect(await collect(single)).toEqual(SAMPLE_EVENTS);
    // 每 5 个字节一块
    const fives: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5)
      fives.push(bytes.subarray(i, i + 5));
    expect(await collect(fives)).toEqual(SAMPLE_EVENTS);
  });

  it("去掉开头的 BOM", async () => {
    const bytes = new TextEncoder().encode("﻿data: x\n\n");
    expect(await collect([bytes])).toEqual([{ event: "", data: "x" }]);
  });

  it("结尾不完整的事件也会分发", async () => {
    const bytes = new TextEncoder().encode("data: 半个事件");
    expect(await collect([bytes])).toEqual([{ event: "", data: "半个事件" }]);
  });

  it("接受同步可迭代的输入", async () => {
    const events: SseEvent[] = [];
    for await (const event of readSseStream([
      new TextEncoder().encode("data: a\n\n"),
    ])) {
      events.push(event);
    }
    expect(events).toEqual([{ event: "", data: "a" }]);
  });

  it("提前 break 时取消底层的流", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readSseStream(stream)) {
      expect(event.data).toBe("x");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
