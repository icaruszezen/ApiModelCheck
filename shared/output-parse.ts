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
/** 这些语言（或没写语言）的围栏，内容是完整的 HTML 文档或一整个 SVG 时也当网页 */
const SNIFF_FENCE_LANGS = new Set(["", "xml", "text", "plaintext", "markup"]);
/**
 * 生成中整段输出先当没写完的 HTML 片段时，开头（XML 声明、注释之后）得是这些搭页面用的标签之一。
 * <b>、<span> 这类行内标签和 <answer>、<reflection> 这类自定义标签开头的回答生成中先当文字
 */
const FRAGMENT_START_TAGS = (
  "!doctype html head body meta link title style script div section main header footer nav " +
  "article aside canvas svg table form h1 h2 h3 h4 h5 h6 p ul ol template"
).split(" ");
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
 * 内容开头可以有的空白、XML 声明和注释。
 * 注释体写成"不跨过 -->"的形式：写成惰性的 [\s\S]*? 时，一长串注释后面没有文档会指数级回溯
 */
const PROLOG = String.raw`\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--(?:(?!-->)[\s\S])*-->\s*)*`;
const LEADING_PROLOG = new RegExp(`^${PROLOG}`, "i");
/** 原始 HTML 文档的开头：<!doctype html 或 <html 开始标签 */
const DOCUMENT_START = String.raw`<!doctype\s+html(?![\w-])|<html(?=[\s>]|$)`;
/** 围栏内容以完整文档开头（允许前面有 XML 声明和注释） */
const DOCUMENT_HEAD = new RegExp(`^${PROLOG}(?:${DOCUMENT_START})`, "i");
/** 围栏内容整个是一张 SVG：（XML 声明、注释之后）以 <svg 开头、以 </svg> 结尾 */
const SVG_HEAD = new RegExp(String.raw`^${PROLOG}<svg(?=[\s>/]|$)`, "i");
const SVG_TAIL = /<\/svg\s*>\s*$/i;

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
  // 这些是在"谈论"这个标签，不算：紧跟在反引号、引号后面的；前面已经出现过 <think> / <thinking> 的
  // （开头标签没被吞，比如"写在 <think> 和 </think> 之间"）；在代码块里面的、在没有围栏的网页文档里面的
  // （网页、脚本里的字符串）
  const opener = /<think(?:ing)?>/i.exec(text);
  const limit = opener ? opener.index : text.length;
  let blocks: Block[] | undefined;
  let inFence: ((pos: number) => boolean) | undefined;
  let inDocument: ((pos: number) => boolean) | undefined;
  const closeRe = /<\/think>/gi;
  for (let match = closeRe.exec(text); match && match.index < limit; match = closeRe.exec(text)) {
    const at = match.index;
    const before = text[at - 1];
    if (before === "`" || before === '"' || before === "'") continue;
    blocks ??= splitFences(text);
    inFence ??= rangeCursor(blocks.filter((block) => block.type === "fence"));
    if (inFence(at)) continue;
    inDocument ??= rangeCursor(rawDocuments(blocks, running));
    if (inDocument(at)) continue;
    return {
      reasoning: text.slice(0, match.index).trim(),
      reasoningOpen: false,
      body: text.slice(match.index + match[0].length),
    };
  }

  return { reasoning: "", reasoningOpen: false, body: text };
}

interface Range {
  from: number;
  to: number;
}

/**
 * 问"pos 在不在某个范围里"。ranges 按位置排好了序，问的位置也是递增的：指针只往前走，
 * 免得成千上万个候选位置变成平方复杂度
 */
function rangeCursor(ranges: Range[]): (pos: number) => boolean {
  let index = 0;
  return (pos) => {
    while (index < ranges.length && ranges[index]!.to <= pos) index++;
    const range = ranges[index];
    return range !== undefined && range.from <= pos;
  };
}

/** 围栏以外的原始 HTML 文档在原文里的范围（和 splitBody 切出来的一样：不跨过围栏） */
function rawDocuments(blocks: Block[], running: boolean): Range[] {
  const ranges: Range[] = [];
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const { start, stop } of findDocuments(block.text, running)) {
      ranges.push({ from: block.from + start, to: block.from + stop });
    }
  }
  return ranges;
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
  /** from：在原文里的起始位置 */
  | { type: "text"; text: string; from: number }
  /** from / to：内容在原文里的起止位置（不含开头、关闭两行） */
  | { type: "fence"; lang: string; content: string; complete: boolean; from: number; to: number };

function splitBody(body: string, running: boolean): OutputSegment[] {
  const segments: OutputSegment[] = [];
  for (const block of splitFences(body)) {
    if (block.type === "text") {
      splitDocuments(block.text, running, segments);
    } else {
      segments.push(fenceSegment(block.lang, block.content, block.complete, running));
    }
  }

  const only = segments.length === 1 ? segments[0] : undefined;
  if (only && only.kind === "text") {
    const fragment = wholeFragment(only.text, running);
    if (fragment) return [fragment];
  }
  return segments;
}

/**
 * 按 CommonMark 的围栏规则切出代码块；没闭合的围栏一直到结尾。
 * 例外：内容是完整 HTML 文档的围栏，在 </html> 之前、脚本之类的元素里遇到的关闭行可能只是网页里的文字，
 * 见 documentFenceEnd
 */
function splitFences(body: string): Block[] {
  const blocks: Block[] = [];
  const lookahead: FenceLookahead = {
    htmlEnd: nextMatchFinder(body, /<\/html\s*>/gi),
    documentStart: nextMatchFinder(body, new RegExp(DOCUMENT_START, "gi")),
  };
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

    if (pos > textStart) blocks.push({ type: "text", text: body.slice(textStart, pos), from: textStart });
    const indent = open[1]!.length;
    const lang = open[3]!.trim().split(/\s+/)[0] ?? "";
    const contentStart = Math.min(lineEnd + 1, body.length);

    let contentEnd = body.length;
    let next = body.length;
    let complete = false;
    for (let cursor = lineEnd + 1; cursor < body.length; ) {
      const end = lineEndAt(body, cursor);
      if (isFenceClose(body.slice(cursor, end), marker)) {
        const key = lang.toLowerCase();
        // 只有关闭行落在网页的脚本、样式、文本框这类元素里面时，才可能是网页里的文字；
        // 否则（比如分几个围栏讲解一张网页、忘了写 </html>）照常在这里结束
        const documentFence =
          (HTML_FENCE_LANGS.has(key) || SNIFF_FENCE_LANGS.has(key)) &&
          DOCUMENT_HEAD.test(body.slice(contentStart, cursor)) &&
          endsInsideVerbatim(body.slice(contentStart, cursor));
        const later = documentFence
          ? documentFenceEnd(body, contentStart, cursor, marker, lookahead)
          : -1;
        const closeAt = later >= 0 ? later : cursor;
        contentEnd = closeAt;
        next = lineEndAt(body, closeAt) + 1;
        complete = true;
        break;
      }
      cursor = end + 1;
    }

    let content = body.slice(contentStart, Math.max(contentStart, contentEnd));
    if (content.endsWith("\n")) content = content.slice(0, -1);
    if (indent > 0) content = dedent(content, indent);
    blocks.push({ type: "fence", lang, content, complete, from: contentStart, to: contentEnd });

    pos = next;
    textStart = Math.min(next, body.length);
  }

  if (textStart < body.length) blocks.push({ type: "text", text: body.slice(textStart), from: textStart });
  return blocks;
}

/** 网页里能原样放一段 Markdown（连同单独一行的 ```）的元素 */
const VERBATIM_TAG = /<(\/?)(script|style|textarea|pre|template)(?=[\s/>]|$)/gi;

/**
 * html 写到结尾时还有没关上的 <script> / <style> / <textarea> / <pre> / <template>。
 * 前三个里面是原样的文字，只认对应的闭合标签；后两个可以嵌套
 */
function endsInsideVerbatim(html: string): boolean {
  let rawText = "";
  let depth = 0;
  for (const match of html.matchAll(VERBATIM_TAG)) {
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    if (rawText !== "") {
      if (closing && name === rawText) rawText = "";
    } else if (name === "pre" || name === "template") {
      depth = closing ? Math.max(0, depth - 1) : depth + 1;
    } else if (!closing) {
      rawText = name;
    }
  }
  return rawText !== "" || depth > 0;
}

/** 这一行能关闭以 marker 开头的围栏：同种字符、不比开头短、后面没有别的 */
function isFenceClose(line: string, marker: string): boolean {
  const closer = FENCE_CLOSE.exec(line)?.[1];
  return closer !== undefined && closer[0] === marker[0] && closer.length >= marker.length;
}

interface FenceLookahead {
  /** pos 之后第一个 </html> 的位置 */
  htmlEnd: (pos: number) => number;
  /** pos 之后第一个文档开头（<!doctype html / <html）的位置 */
  documentStart: (pos: number) => number;
}

/**
 * 内容是完整文档的围栏，在 </html> 之前、脚本之类的元素里面就遇到了关闭行（cursor）：多半是网页脚本字符串里的
 * Markdown 示例。后面还有 </html>、它之后（隔着空行也行）紧跟着关闭行时，到那一行才算结束，返回它的位置。
 * 其余情况（包括中间又出现了新文档的开头，免得把两个网页并成一个）照常在 cursor 结束，返回 -1
 */
function documentFenceEnd(
  body: string,
  contentStart: number,
  cursor: number,
  marker: string,
  lookahead: FenceLookahead,
): number {
  const htmlEnd = lookahead.htmlEnd(contentStart);
  if (htmlEnd < cursor) return -1;
  const nextDocument = lookahead.documentStart(cursor);
  if (nextDocument >= 0 && nextDocument < htmlEnd) return -1;

  const tagEnd = body.indexOf(">", htmlEnd) + 1;
  let lineEnd = lineEndAt(body, tagEnd);
  if (body.slice(tagEnd, lineEnd).trim() !== "") return -1;
  while (lineEnd < body.length) {
    const start = lineEnd + 1;
    lineEnd = lineEndAt(body, start);
    const line = body.slice(start, lineEnd);
    if (line.trim() === "") continue;
    return isFenceClose(line, marker) ? start : -1;
  }
  return -1;
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

function fenceSegment(
  lang: string,
  content: string,
  complete: boolean,
  running: boolean,
): OutputSegment {
  const key = lang.toLowerCase();
  if (HTML_FENCE_LANGS.has(key) || (SNIFF_FENCE_LANGS.has(key) && sniffsAsPage(content, complete, running))) {
    return { kind: "html", html: content, complete, source: "fence" };
  }
  return { kind: "code", lang, code: content, complete };
}

/**
 * 没写语言（或 xml / text 之类）的围栏：内容是完整 HTML 文档，或者整个就是一张 SVG。
 * "整个是 SVG"要看结尾，生成中的围栏写到 </svg>、又写出半截关闭行时会来回变，所以等围栏关上（或生成结束）才认
 */
function sniffsAsPage(content: string, complete: boolean, running: boolean): boolean {
  if (DOCUMENT_HEAD.test(content)) return true;
  return (complete || !running) && SVG_HEAD.test(content) && SVG_TAIL.test(content);
}

/** 在围栏以外的文字里找原始的 HTML 文档，切成 文字 / 网页 / 文字… */
function splitDocuments(text: string, running: boolean, out: OutputSegment[]): void {
  let cursor = 0;
  for (const { start, stop, complete } of findDocuments(text, running)) {
    pushText(out, text.slice(cursor, start));
    out.push({ kind: "html", html: text.slice(start, stop), complete, source: "document" });
    cursor = stop;
  }
  pushText(out, text.slice(cursor));
}

interface DocumentRange {
  start: number;
  /** 到 </html> 为止；没写 </html> 就到结尾 */
  stop: number;
  complete: boolean;
}

/** 文字里的原始 HTML 文档，按位置排好 */
function findDocuments(text: string, running: boolean): DocumentRange[] {
  const lookahead: Lookahead = {
    section: nextMatchFinder(text, /<(?:head|body)(?=[\s>/]|$)/gi),
    closer: nextMatchFinder(text, /<\/[a-z][\w-]*\s*>/gi),
  };
  const documents: DocumentRange[] = [];
  let cursor = 0;
  for (;;) {
    const start = findDocumentStart(text, cursor, running, lookahead);
    if (start < 0) break;
    const endRe = /<\/html\s*>/gi;
    endRe.lastIndex = start;
    const end = endRe.exec(text);
    const stop = end ? end.index + end[0].length : text.length;
    documents.push({ start, stop, complete: end !== null });
    cursor = stop;
  }
  return documents;
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

/**
 * 整段输出只剩一段文字、而它本身就是一段 HTML 时，当网页显示。
 * 生成中只看开头是不是搭页面用的标签（FRAGMENT_START_TAGS），免得 <answer>、<b> 开头的回答先显示成网页、写完又变回文字；
 * 写完时看整段：以 < 开头、以 > 结尾，并且有 FRAGMENT_CLOSERS 里的闭合标签（<button>、<details> 开头的片段也能显示）
 */
function wholeFragment(text: string, running: boolean): OutputSegment | null {
  const trimmed = text.trim();
  if (running) {
    if (!startsWithPageTag(trimmed)) return null;
    // 生成中永远算没写完：写完之前不渲染，免得每来一段增量就重载一次
    return { kind: "html", html: trimmed, complete: false, source: "fragment" };
  }
  if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) return null;
  const lower = trimmed.toLowerCase();
  if (!FRAGMENT_CLOSERS.some((closer) => lower.includes(closer))) return null;
  return { kind: "html", html: trimmed, complete: true, source: "fragment" };
}

/** 以 doctype 开头的片段：声明后面紧跟着标签（或者什么都没有），不是"<!DOCTYPE html> 是……"这种文字 */
const DOCTYPE_FRAGMENT = /^<!doctype\s+html\s*>\s*(?:<|$)/i;
/** 生成中 doctype 声明还没写到 html（"<!DOCTYPE "、"<!DOCTYPE ht"）：写到 html 以后就交给 splitDocuments */
const PARTIAL_DOCTYPE = /^<!doctype\s+(?:h(?:t(?:ml?)?)?)?$/i;

/**
 * （XML 声明、注释之后）以 FRAGMENT_START_TAGS 里的标签开头：标签名后面是空白、>、/ 或者结尾。
 * 只在生成中用：标签名可能只写了一半（"<di"、"<!DOC"），是其中某个的前缀也算；
 * 但至少要两个字，只有一个字母分不出来（"<b" 可能是 <body>，也可能是 <b>结论</b>），先当文字
 */
function startsWithPageTag(text: string): boolean {
  const rest = text.slice(LEADING_PROLOG.exec(text)?.[0].length ?? 0);
  const tag = /^<(!?[a-z0-9]*)([\s\S]?)/i.exec(rest);
  if (!tag) return false;
  const name = tag[1]!.toLowerCase();
  const after = tag[2]!;
  if (after !== "") {
    if (!/[\s>/]/.test(after) || !FRAGMENT_START_TAGS.includes(name)) return false;
    return name !== "!doctype" || DOCTYPE_FRAGMENT.test(rest) || PARTIAL_DOCTYPE.test(rest);
  }
  if (FRAGMENT_START_TAGS.includes(name)) return true;
  return name.length >= 2 && FRAGMENT_START_TAGS.some((start) => start.startsWith(name));
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
