/**
 * Server-Sent Events 解析。切行、字段的规则按 WHATWG 规范：\r\n、\n、\r 都算换行，
 * `:` 开头是注释，多行 data 用 \n 连起来，空行分发一个事件。
 * 和规范不同的一点：流结束时还没分发的事件也会分发——有些上游最后不写空行就断开连接。
 */

export interface SseEvent {
  /** `event:` 字段；没写时是空串 */
  event: string;
  data: string;
}

export class SseParser {
  /** 还没遇到换行的半行 */
  #buffer = "";
  /** 上一段恰好以 \r 结尾：下一段开头的 \n 和它是同一个换行 */
  #skipLeadingLF = false;
  #event = "";
  #data: string[] = [];

  /** 喂入一段已解码的文本，返回这一段里凑齐的事件 */
  feed(text: string): SseEvent[] {
    if (text === "") return [];
    if (this.#skipLeadingLF) {
      this.#skipLeadingLF = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    const events: SseEvent[] = [];
    const buffer = this.#buffer + text;
    const lineBreak = /\r\n|\r|\n/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = lineBreak.exec(buffer)) !== null) {
      this.#processLine(buffer.slice(start, match.index), events);
      start = match.index + match[0].length;
      if (match[0] === "\r" && start === buffer.length) {
        this.#skipLeadingLF = true;
      }
    }
    this.#buffer = buffer.slice(start);
    return events;
  }

  /** 流结束：处理最后半行，并把还没分发的事件分发掉 */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.#buffer !== "") {
      this.#processLine(this.#buffer, events);
      this.#buffer = "";
    }
    this.#dispatch(events);
    this.#skipLeadingLF = false;
    return events;
  }

  #processLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.#dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    // id、retry 用不到，忽略
  }

  #dispatch(events: SseEvent[]): void {
    // 规范：没有 data 行的事件不分发（只重置事件名）
    if (this.#data.length > 0) {
      events.push({ event: this.#event, data: this.#data.join("\n") });
    }
    this.#event = "";
    this.#data = [];
  }
}

/**
 * 把字节流解析成事件序列。按流式模式解码 UTF-8，一个汉字被拆在两段里也不会乱码。
 * 消费方提前 break 时，生成器的 return 会顺带取消底层的响应体。
 */
export async function* readSseStream(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for await (const chunk of body) {
    yield* parser.feed(decoder.decode(chunk, { stream: true }));
  }
  yield* parser.feed(decoder.decode());
  yield* parser.end();
}
