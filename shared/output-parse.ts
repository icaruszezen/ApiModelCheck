/**
 * 把模型的正文输出拆成可以分别展示的几段：普通文字、代码块、HTML 网页。
 * 前端据此决定哪些内容放进沙箱 iframe 里渲染。只做字符串处理，前后端都能用。
 *
 * 模型不一定只输出一个干净的网页：网页可能包在 ```html 围栏里、夹在说明文字中间，
 * 也可能连围栏都没有、从一行的中间直接开始写 <!DOCTYPE html>。这里的规则就是为这些情况定的。
 */

export type OutputSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; code: string; complete: boolean }
  | {
      kind: "html";
      html: string;
      complete: boolean;
      source: "fence" | "document" | "fragment";
    };

export interface ParsedOutput {
  /** 正文开头 <think>…</think>（或 <thinking>）里的思考过程，没有就是空串 */
  reasoning: string;
  /** 思考过程还没写完（只有开头标签，还在生成中） */
  reasoningOpen: boolean;
  segments: OutputSegment[];
}

export interface ParseOutputOptions {
  /** 输出还在生成中（流式的部分输出） */
  running?: boolean;
}

/** 这些语言的围栏一定是网页 */
const HTML_FENCE_LANGS = new Set(["html", "htm", "xhtml", "svg"]);
/** 这些语言（或没写语言）的围栏，内容是完整的 HTML 文档时也当网页 */
const SNIFF_FENCE_LANGS = new Set(["", "xml", "text", "plaintext", "markup"]);
/** 整段输出就是一个 HTML 片段时，至少要出现其中一个闭合标签 */
const FRAGMENT_CLOSERS = [
  "</div>",
  "</style>",
  "</script>",
  "</body>",
  "</svg>",
  "</section>",
  "</main>",
  "</table>",
  "</canvas>",
  "</ul>",
];

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/**
 * 围栏内容以完整文档开头（允许前面有 XML 声明和注释）。
 * 注释体写成"不跨过 -->"的形式：写成惰性的 [\s\S]*? 时，一长串注释后面没有文档会指数级回溯
 */
const DOCUMENT_HEAD =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--(?:(?!-->)[\s\S])*-->\s*)*(?:<!doctype\s+html(?![\w-])|<html(?=[\s>]|$))/i;

export function parseOutput(
  output: string,
  options: ParseOutputOptions = {},
): ParsedOutput {
  const running = options.running === true;
  // 统一换行，后面只需要按 \n 切行
  const text = output.replace(/\r\n?/g, "\n");
  const { reasoning, reasoningOpen, body } = splitReasoning(text, running);
  return { reasoning, reasoningOpen, segments: splitBody(body, running) };
}

/* ------------------------------------------------------------------ */
/* 思考标签                                                            */
/* ------------------------------------------------------------------ */

interface ReasoningSplit {
  reasoning: string;
  reasoningOpen: boolean;
  body: string;
}

function splitReasoning(text: string, running: boolean): ReasoningSplit {
  const rest = text.trimStart();
  const open = /^<(think|thinking)>/i.exec(rest);
  if (open) {
    const closeTag = `</${open[1]!.toLowerCase()}>`;
    const contentStart = open[0].length;
    const closeRe = new RegExp(closeTag, "gi");
    closeRe.lastIndex = contentStart;
    const close = closeRe.exec(rest);
    if (!close) {
      // 还在思考；流式时闭合标签可能只到了一半（"</thi"），先不显示这一截
      const content = stripPartialSuffix(rest.slice(contentStart), closeTag);
      return { reasoning: content.trim(), reasoningOpen: true, body: "" };
    }
    return {
      reasoning: rest.slice(contentStart, close.index).trim(),
      reasoningOpen: false,
      body: rest.slice(close.index + close[0].length),
    };
  }

  // 开头标签本身还没传完（"<thi"）：先当成正在思考，免得一闪而过地显示成文字或网页
  if (running && rest.length >= 2 && "<thinking>".startsWith(rest.toLowerCase())) {
    return { reasoning: "", reasoningOpen: true, body: "" };
  }

  // 有的中转会吞掉开头的 <think>，只留下 </think>：它之前的都是思考过程。
  // 紧跟在反引号、引号后面的是在"谈论"这个标签，不算
  const closeRe = /<\/think>/gi;
  for (let match = closeRe.exec(text); match; match = closeRe.exec(text)) {
    const before = text[match.index - 1];
    if (before === "`" || before === '"' || before === "'") continue;
    return {
      reasoning: text.slice(0, match.index).trim(),
      reasoningOpen: false,
      body: text.slice(match.index + match[0].length),
    };
  }

  return { reasoning: "", reasoningOpen: false, body: text };
}

/** 去掉结尾处 tag 的一段前缀（不分大小写） */
function stripPartialSuffix(text: string, tag: string): string {
  const lower = text.toLowerCase();
  for (let size = Math.min(tag.length - 1, text.length); size > 0; size--) {
    if (lower.endsWith(tag.slice(0, size))) return text.slice(0, -size);
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* 正文                                                                */
/* ------------------------------------------------------------------ */

type Block =
  | { type: "text"; text: string }
  | { type: "fence"; lang: string; content: string; complete: boolean };

function splitBody(body: string, running: boolean): OutputSegment[] {
  const segments: OutputSegment[] = [];
  for (const block of splitFences(body)) {
    if (block.type === "text") {
      splitDocuments(block.text, running, segments);
    } else {
      segments.push(fenceSegment(block.lang, block.content, block.complete));
    }
  }

  const only = segments.length === 1 ? segments[0] : undefined;
  if (only && only.kind === "text") {
    const fragment = wholeFragment(only.text, running);
    if (fragment) return [fragment];
  }
  return segments;
}

/** 按 CommonMark 的围栏规则切出代码块；没闭合的围栏一直到结尾 */
function splitFences(body: string): Block[] {
  const blocks: Block[] = [];
  let textStart = 0;
  let pos = 0;

  while (pos < body.length) {
    const lineEnd = lineEndAt(body, pos);
    const open = FENCE_OPEN.exec(body.slice(pos, lineEnd));
    const marker = open?.[2];
    // 反引号围栏的信息串里不能再有反引号（```js``` 是行内代码，不是围栏）
    if (!open || !marker || (marker[0] === "`" && open[3]!.includes("`"))) {
      pos = lineEnd + 1;
      continue;
    }

    if (pos > textStart) blocks.push({ type: "text", text: body.slice(textStart, pos) });
    const indent = open[1]!.length;
    const lang = open[3]!.trim().split(/\s+/)[0] ?? "";
    const contentStart = Math.min(lineEnd + 1, body.length);

    let contentEnd = body.length;
    let next = body.length;
    let complete = false;
    for (let cursor = lineEnd + 1; cursor < body.length; ) {
      const end = lineEndAt(body, cursor);
      const close = FENCE_CLOSE.exec(body.slice(cursor, end));
      const closer = close?.[1];
      if (closer && closer[0] === marker[0] && closer.length >= marker.length) {
        contentEnd = cursor;
        next = end + 1;
        complete = true;
        break;
      }
      cursor = end + 1;
    }

    let content = body.slice(contentStart, Math.max(contentStart, contentEnd));
    if (content.endsWith("\n")) content = content.slice(0, -1);
    if (indent > 0) content = dedent(content, indent);
    blocks.push({ type: "fence", lang, content, complete });

    pos = next;
    textStart = Math.min(next, body.length);
  }

  if (textStart < body.length) blocks.push({ type: "text", text: body.slice(textStart) });
  return blocks;
}

function lineEndAt(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end < 0 ? text.length : end;
}

/** 围栏缩进了几格，内容的每一行就最多去掉几格 */
function dedent(content: string, indent: number): string {
  return content
    .split("\n")
    .map((line) => {
      let cut = 0;
      while (cut < indent && line[cut] === " ") cut++;
      return line.slice(cut);
    })
    .join("\n");
}

function fenceSegment(lang: string, content: string, complete: boolean): OutputSegment {
  const key = lang.toLowerCase();
  if (HTML_FENCE_LANGS.has(key) || (SNIFF_FENCE_LANGS.has(key) && DOCUMENT_HEAD.test(content))) {
    return { kind: "html", html: content, complete, source: "fence" };
  }
  return { kind: "code", lang, code: content, complete };
}

/** 在围栏以外的文字里找原始的 HTML 文档，切成 文字 / 网页 / 文字… */
function splitDocuments(text: string, running: boolean, out: OutputSegment[]): void {
  const lookahead: Lookahead = {
    section: nextMatchFinder(text, /<(?:head|body)(?=[\s>/]|$)/gi),
    closer: nextMatchFinder(text, /<\/[a-z][\w-]*\s*>/gi),
  };
  let cursor = 0;
  for (;;) {
    const start = findDocumentStart(text, cursor, running, lookahead);
    if (start < 0) break;
    pushText(out, text.slice(cursor, start));

    const endRe = /<\/html\s*>/gi;
    endRe.lastIndex = start;
    const end = endRe.exec(text);
    const stop = end ? end.index + end[0].length : text.length;
    out.push({ kind: "html", html: text.slice(start, stop), complete: end !== null, source: "document" });
    cursor = stop;
  }
  pushText(out, text.slice(cursor));
}

interface Lookahead {
  /** pos 之后第一个 <head / <body 的位置 */
  section: (pos: number) => number;
  /** pos 之后第一个闭合标签的位置 */
  closer: (pos: number) => number;
}

/**
 * "从 pos 往后第一个匹配在哪"，记住上一次的结果：候选位置是递增的，
 * 上次找到的匹配还在 pos 之后就直接用。否则遇到一长串"<html><body>"这样的输入会变成平方复杂度。
 */
function nextMatchFinder(text: string, re: RegExp): (pos: number) => number {
  let searchedFrom = -1;
  let found = -1;
  return (pos) => {
    if (searchedFrom >= 0 && pos >= searchedFrom && (found < 0 || found >= pos)) return found;
    re.lastIndex = pos;
    found = re.exec(text)?.index ?? -1;
    searchedFrom = pos;
    return found;
  };
}

/** doctype 声明、<html> 开始标签最长各允许多少字（再长就不像了），也免得每个候选都扫到结尾 */
const DOCTYPE_MAX = 500;
const HTML_TAG_MAX = 1000;

function findDocumentStart(
  text: string,
  from: number,
  running: boolean,
  lookahead: Lookahead,
): number {
  const startRe = /<!doctype\s+html(?![\w-])|<html(?=[\s>]|$)/gi;
  startRe.lastIndex = from;
  for (let match = startRe.exec(text); match; match = startRe.exec(text)) {
    // 行内代码里的 `<!DOCTYPE html>` 是在讲语法，不是网页
    if (text[match.index - 1] === "`") continue;
    const after = match.index + match[0].length;
    const valid =
      match[0][1] === "!"
        ? isDoctypeStart(text, after, running)
        : isHtmlTagStart(text, after, lookahead);
    if (valid) return match.index;
  }
  return -1;
}

/**
 * `<!doctype html` 之后：声明要正常结束，并且紧跟着就是标签——
 * 这样"第一行要写 <!DOCTYPE html> 声明"这种说明文字不会被当成网页。
 * 生成中时声明可能正好写到一半或刚写完，后面还没有内容，也算。
 */
function isDoctypeStart(text: string, after: number, running: boolean): boolean {
  const close = findWithin(text, ">", after, DOCTYPE_MAX);
  const nextTag = findWithin(text, "<", after, close < 0 ? DOCTYPE_MAX : close - after);
  if (nextTag >= 0) return false;
  if (close < 0) return running && text.length - after <= DOCTYPE_MAX;
  const next = skipSpaces(text, close + 1);
  if (next >= text.length) return running;
  return text[next] === "<";
}

/**
 * `<html` 之后：开始标签要完整，紧跟着是别的标签，后面确实有 <head> 或 <body>，
 * 并且出现过闭合标签。"用 <html> 元素包住全部内容"这种说明文字一条都过不了。
 */
function isHtmlTagStart(text: string, after: number, lookahead: Lookahead): boolean {
  const close = findWithin(text, ">", after, HTML_TAG_MAX);
  if (close < 0 || findWithin(text, "<", after, close - after) >= 0) return false;
  const next = skipSpaces(text, close + 1);
  if (text[next] !== "<") return false;
  return lookahead.section(next) >= 0 && lookahead.closer(next) >= 0;
}

/** 只在 from 之后 maxDistance 个字以内找 */
function findWithin(text: string, char: string, from: number, maxDistance: number): number {
  const at = text.slice(from, from + maxDistance + 1).indexOf(char);
  return at < 0 ? -1 : from + at;
}

function skipSpaces(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
}

/** 整段输出只剩一段文字、而它本身就是一段 HTML 时，当网页显示 */
function wholeFragment(text: string, running: boolean): OutputSegment | null {
  const trimmed = text.trim();
  if (running) {
    // 生成中永远算没写完：写完之前不渲染，免得每来一段增量就重载一次
    return /^<[a-z]/i.test(trimmed)
      ? { kind: "html", html: trimmed, complete: false, source: "fragment" }
      : null;
  }
  if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) return null;
  const lower = trimmed.toLowerCase();
  if (!FRAGMENT_CLOSERS.some((closer) => lower.includes(closer))) return null;
  return { kind: "html", html: trimmed, complete: true, source: "fragment" };
}

/** 空白的文字段丢掉；首尾的空行去掉（各段之间本来就有间距），中间的换行原样保留 */
function pushText(out: OutputSegment[], text: string): void {
  const end = text.trimEnd().length;
  if (end === 0) return;
  const leading = text.length - text.trimStart().length;
  // 只去到开头空白里的最后一个换行：第一行自己的缩进留着
  const start = text.lastIndexOf("\n", leading - 1) + 1;
  out.push({ kind: "text", text: text.slice(start, end) });
}
