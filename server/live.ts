/**
 * 正在进行的检测的"实时输出"，只放在内存里：流式增量先累积在这里，
 * 前台轮询时用它替换数据库里 running 记录的 output / reasoning，检测结束写库后删掉。
 */

export interface LiveOutput {
  output: string;
  reasoning: string;
}

export class LiveOutputs {
  readonly #entries = new Map<number, LiveOutput>();

  start(resultId: number): void {
    this.#entries.set(resultId, { output: "", reasoning: "" });
  }

  append(
    resultId: number,
    delta: { output?: string; reasoning?: string },
  ): void {
    const entry = this.#entries.get(resultId);
    if (!entry) return;
    if (delta.output) entry.output += delta.output;
    if (delta.reasoning) entry.reasoning += delta.reasoning;
  }

  /** 返回一份快照，调用方拿去序列化时不会被后续增量改到 */
  get(resultId: number): LiveOutput | undefined {
    const entry = this.#entries.get(resultId);
    return entry
      ? { output: entry.output, reasoning: entry.reasoning }
      : undefined;
  }

  delete(resultId: number): void {
    this.#entries.delete(resultId);
  }

  get size(): number {
    return this.#entries.size;
  }
}
