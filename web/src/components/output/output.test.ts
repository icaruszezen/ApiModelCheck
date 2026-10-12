import { ToastProvider } from "@endfield-ui/react";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HtmlPreview } from "./HtmlPreview";
import { OutputView } from "./OutputView";
import { SandboxFrame } from "./SandboxFrame";
import {
  buildSrcDoc,
  byteLength,
  countChars,
  formatBytes,
  injectSandboxShims,
  isFullDocument,
  SANDBOX_POLICY,
  STORAGE_SHIM,
  tailLines,
} from "./srcdoc";
import { STATUS_LABELS, StatusTag } from "./StatusTag";

const WRAP_HEAD =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';

/** CopyButton 要用 useToast，渲染时包一层 ToastProvider（应用里 App.tsx 已经包了） */
function render(element: ReactElement): string {
  return renderToStaticMarkup(createElement(ToastProvider, null, element));
}

function iframes(markup: string): string[] {
  return markup.match(/<iframe\b[^>]*>/g) ?? [];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("buildSrcDoc", () => {
  it("片段包一层最小的文档骨架", () => {
    const html = '<div class="a">hi</div><style>.a{color:red}</style>';
    const doc = buildSrcDoc(html, "fragment");
    expect(doc.startsWith(WRAP_HEAD)).toBe(true);
    expect(doc.endsWith(`</head><body>${html}</body></html>`)).toBe(true);
    expect(doc).toBe(`${WRAP_HEAD}${STORAGE_SHIM}</head><body>${html}</body></html>`);
  });

  it("围栏里不是完整文档的内容同样包一层", () => {
    const svg = '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    expect(buildSrcDoc(svg, "fence")).toBe(`${WRAP_HEAD}${STORAGE_SHIM}</head><body>${svg}</body></html>`);
  });

  it("完整文档原样使用：只在 doctype 后面补上替身脚本", () => {
    const doc = '<!DOCTYPE html>\n<html lang="zh"><head><title>t</title></head><body>x</body></html>';
    for (const source of ["document", "fence"] as const) {
      const result = buildSrcDoc(doc, source);
      expect(result.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(result).toBe(`<!DOCTYPE html>${STORAGE_SHIM}\n<html lang="zh"><head><title>t</title></head><body>x</body></html>`);
      expect(result.replace(STORAGE_SHIM, "")).toBe(doc);
    }
  });

  it("围栏里有 <html> 但没有 doctype 的也是完整文档", () => {
    const doc = "<html><body>x</body></html>";
    expect(buildSrcDoc(doc, "fence")).toBe(`${STORAGE_SHIM}${doc}`);
  });

  it("document 来源一律当完整文档，哪怕只写了一半", () => {
    expect(buildSrcDoc("<!doctype html><html><body><div>", "document")).toBe(
      `<!doctype html>${STORAGE_SHIM}<html><body><div>`,
    );
  });

  it("doctype 前面有注释、XML 声明时，替身脚本仍然放在 doctype 后面", () => {
    expect(injectSandboxShims("<!-- 首页 -->\n<!DOCTYPE html><p>x</p>")).toBe(
      `<!-- 首页 -->\n<!DOCTYPE html>${STORAGE_SHIM}<p>x</p>`,
    );
    expect(injectSandboxShims('<?xml version="1.0"?>\n<!DOCTYPE html PUBLIC "x" "y"><html></html>')).toBe(
      `<?xml version="1.0"?>\n<!DOCTYPE html PUBLIC "x" "y">${STORAGE_SHIM}<html></html>`,
    );
  });

  it("替身脚本：存储一碰就抛错时换成内存存储，本来能用时不动", () => {
    const code = STORAGE_SHIM.slice("<script>".length, -"</script>".length);
    const sandboxed: Record<string, unknown> = {};
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(sandboxed, name, {
        configurable: true,
        get() {
          throw new Error("SecurityError: The document is sandboxed");
        },
      });
    }
    new Function("window", code)(sandboxed);
    const storage = sandboxed.localStorage as Storage;
    storage.setItem("best", "42");
    expect(storage.getItem("best")).toBe("42");
    expect(storage.getItem("none")).toBeNull();
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe("best");
    storage.removeItem("best");
    expect(storage.length).toBe(0);
    expect(sandboxed.sessionStorage).not.toBe(storage);

    const real = { getItem: () => null };
    const normal = { localStorage: real, sessionStorage: real };
    new Function("window", code)(normal);
    expect(normal.localStorage).toBe(real);
  });

  it("一长串注释后面没有 doctype 时不会卡住", () => {
    const comments = "<!-- c -->".repeat(60);
    expect(injectSandboxShims(`${comments}<html></html>`)).toBe(`${STORAGE_SHIM}${comments}<html></html>`);
  });

  it("替身脚本本身不带任何外部资源", () => {
    expect(STORAGE_SHIM.startsWith("<script>")).toBe(true);
    expect(STORAGE_SHIM.endsWith("</script>")).toBe(true);
    expect(STORAGE_SHIM).not.toMatch(/src=|https?:|fetch|parent|top\./);
  });
});

describe("isFullDocument", () => {
  it("有 doctype 或 <html> 开始标签才算", () => {
    expect(isFullDocument("<!DOCTYPE html><p>x</p>")).toBe(true);
    expect(isFullDocument('<html lang="en"></html>')).toBe(true);
    expect(isFullDocument("<HTML>")).toBe(true);
    expect(isFullDocument("<div>x</div>")).toBe(false);
    expect(isFullDocument("<htmlx>")).toBe(false);
  });
});

describe("小工具", () => {
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(3277)).toBe("3.2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("byteLength 按 UTF-8 计", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("时钟")).toBe(6);
  });

  it("tailLines 取最后几行并给出省掉的行数", () => {
    expect(tailLines("a\nb\nc", 5)).toEqual({ text: "a\nb\nc", omitted: 0 });
    expect(tailLines("a\nb\nc\nd", 2)).toEqual({ text: "c\nd", omitted: 2 });
  });

  it("countChars 按码点计、不算空白", () => {
    expect(countChars("")).toBe(0);
    expect(countChars("智商 IQ\n")).toBe(4);
    expect(countChars("👍👍")).toBe(2);
  });
});

describe("SandboxFrame", () => {
  it("沙箱权限只有 allow-scripts，内容走 srcdoc", () => {
    expect(SANDBOX_POLICY).toBe("allow-scripts");
    const markup = renderToStaticMarkup(
      createElement(SandboxFrame, {
        srcDoc: '<!doctype html><script>alert("x")</script>',
        title: "模型生成的网页",
        height: 360,
      }),
    );
    const [frame, ...rest] = iframes(markup);
    expect(rest).toHaveLength(0);
    expect(frame).toBeDefined();
    expect(attr(frame!, "sandbox")).toBe("allow-scripts");
    expect(attr(frame!, "srcDoc") ?? attr(frame!, "srcdoc")).toBe(
      "&lt;!doctype html&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(attr(frame!, "referrerPolicy") ?? attr(frame!, "referrerpolicy")).toBe("no-referrer");
    expect(attr(frame!, "loading")).toBe("lazy");
    expect(attr(frame!, "title")).toBe("模型生成的网页");
    expect(attr(frame!, "style")).toContain("color-scheme:light");
    expect(attr(frame!, "style")).toContain("background-color:#fff");
    expect(markup).not.toMatch(/allow-same-origin|allow-popups|allow-forms|allow-top-navigation|allow-modals/);
    expect(markup).not.toMatch(/\ssrc="/);
  });

  it("弹窗里的不懒加载", () => {
    const markup = renderToStaticMarkup(
      createElement(SandboxFrame, { srcDoc: "x", title: "t", height: "80vh", lazy: false }),
    );
    expect(attr(iframes(markup)[0]!, "loading")).toBe("eager");
  });
});

describe("HtmlPreview", () => {
  const html = "<!DOCTYPE html><html><body><h1>时钟</h1></body></html>";

  it("写完的网页渲染成一个沙箱 iframe，带工具条", () => {
    const markup = render(createElement(HtmlPreview, { html, source: "document", complete: true }));
    const frames = iframes(markup);
    expect(frames).toHaveLength(1);
    expect(attr(frames[0]!, "sandbox")).toBe("allow-scripts");
    expect(markup).toContain("HTML 网页");
    expect(markup).toContain(formatBytes(byteLength(html)));
    expect(markup).toContain("预览");
    expect(markup).toContain("源码");
    expect(markup).toContain('aria-label="全屏查看"');
    expect(markup).not.toContain("网页没有写完");
    expect(markup).not.toContain("allow-same-origin");
  });

  it("生成中还没写完：不渲染 iframe，显示源码末尾", () => {
    const partial = Array.from({ length: 60 }, (_, i) => `<p>第 ${i + 1} 行</p>`).join("\n");
    const markup = render(
      createElement(HtmlPreview, { html: partial, source: "fence", complete: false, running: true }),
    );
    expect(iframes(markup)).toHaveLength(0);
    expect(markup).toContain("网页生成中，写完后自动预览");
    expect(markup).toContain("第 60 行");
    expect(markup).not.toContain("第 1 行<");
  });

  it("生成结束了但没写完：照常渲染，并提示可能被截断", () => {
    const markup = render(
      createElement(HtmlPreview, { html: "<div><p>截断", source: "fence", complete: false }),
    );
    expect(iframes(markup)).toHaveLength(1);
    expect(markup).toContain("网页没有写完（输出可能被截断）");
  });

  it("生成中但已经写完的网页直接渲染", () => {
    const markup = render(
      createElement(HtmlPreview, { html, source: "fence", complete: true, running: true }),
    );
    expect(iframes(markup)).toHaveLength(1);
  });
});

describe("OutputView", () => {
  it("文字夹着网页：文字原样转义显示，网页进沙箱", () => {
    const output =
      '先说明：<script>alert(1)</script> 不会执行。\n\n```html\n<div id="x">卡片</div>\n```\n\n结束 <img src=x onerror=alert(2)>';
    const markup = render(createElement(OutputView, { output }));
    const frames = iframes(markup);
    expect(frames).toHaveLength(1);
    expect(attr(frames[0]!, "sandbox")).toBe("allow-scripts");
    // 模型的文字只能以转义后的形式出现
    expect(markup).not.toContain("<script>alert(1)</script>");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("先说明：&lt;script&gt;alert(1)&lt;/script&gt; 不会执行。");
    expect(markup).toContain("结束 &lt;img src=x onerror=alert(2)&gt;");
    expect(markup).toContain('aria-label="复制原文"');
    expect(markup).toContain("1 个网页");
  });

  it("紧凑版：正文放进可以滚动的区域，网页的小方框矮一些", () => {
    const output = '前言\n\n```html\n<div id="x">卡片</div>\n```';
    const normal = render(createElement(OutputView, { output }));
    const compact = render(createElement(OutputView, { output, compact: true }));
    expect(normal).not.toContain('aria-label="模型输出"');
    expect(attr(iframes(normal)[0]!, "style")).toContain("height:360px");
    expect(compact).toContain('role="region" aria-label="模型输出"');
    expect(attr(iframes(compact)[0]!, "style")).toContain("height:260px");
    // 没有正文时不画空的滚动区域
    expect(render(createElement(OutputView, { output: "", compact: true }))).not.toContain(
      'aria-label="模型输出"',
    );
  });

  it("代码块显示语言和代码", () => {
    const markup = render(createElement(OutputView, { output: "```python\nprint('<b>')\n```" }));
    expect(iframes(markup)).toHaveLength(0);
    expect(markup).toContain("python");
    expect(markup).toContain("print(&#x27;&lt;b&gt;&#x27;)");
    expect(markup).toContain('aria-label="复制代码"');
  });

  it("多个网页时各自带序号", () => {
    const output = "```html\n<p>1</p>\n```\n```html\n<p>2</p>\n```";
    const markup = render(createElement(OutputView, { output }));
    expect(iframes(markup).map((tag) => attr(tag, "title"))).toEqual([
      "模型生成的网页 1",
      "模型生成的网页 2",
    ]);
  });

  it("生成中以 <answer> 这类标签开头的回答直接显示文字，不当网页", () => {
    const markup = render(createElement(OutputView, { output: "<answer>9.9 更大，因为", running: true }));
    expect(markup).not.toContain("网页生成中");
    expect(markup).not.toContain("HTML 网页");
    expect(markup).toContain("&lt;answer&gt;9.9 更大，因为");
    expect(markup).toContain("正在生成…");
  });

  it("网页脚本里单独一行的 ``` 不会把网页切断", () => {
    const output = [
      "Markdown 预览页：",
      "```html",
      "<!DOCTYPE html>",
      '<html><body><pre id="o"></pre><script>',
      "const md = `",
      "```js",
      "console.log(1)",
      "```",
      "`;",
      "document.getElementById('o').textContent = md;",
      "</script></body></html>",
      "```",
      "以上。",
    ].join("\n");
    const markup = render(createElement(OutputView, { output }));
    expect(iframes(markup)).toHaveLength(1);
    expect(markup).toContain("1 个网页");
    expect(markup).not.toContain("没有写完");
    expect(markup).not.toContain('aria-label="复制代码"');
    expect(markup).toContain(">以上。</div>");
  });

  it("没写语言、内容是一张 SVG 的代码块当网页显示", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    const markup = render(createElement(OutputView, { output: `图标：\n\`\`\`\n${svg}\n\`\`\`` }));
    expect(iframes(markup)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="复制代码"');
  });

  it("文字里谈到 <think> 和 </think> 时，答案不会被收进思考过程", () => {
    const output = "推理模型会先把思考过程写在 <think> 和 </think> 之间，然后才给出正式答案。9.9 比 9.11 大。";
    const markup = render(createElement(OutputView, { output }));
    expect(markup).not.toContain(">思考过程</span>");
    expect(markup).toContain(`>${output.replace("<think>", "&lt;think&gt;").replace("</think>", "&lt;/think&gt;")}</div>`);
  });

  it("以 <!DOCTYPE html> 开头的说明文字生成中直接显示文字，不当网页", () => {
    const output = "<!DOCTYPE html> 是 HTML5 的文档类型声明，它告诉浏览器用标准模式渲染页面。";
    for (const running of [true, false]) {
      const markup = render(createElement(OutputView, { output, running }));
      expect(markup).not.toContain("网页生成中");
      expect(markup).not.toContain("HTML 网页");
      expect(markup).toContain("&lt;!DOCTYPE html&gt; 是 HTML5");
    }
  });

  it("写完的 <button> 片段渲染成网页，生成中先显示文字", () => {
    const output = '<button id="b">点我</button>\n<script>b.onclick=()=>alert(\'hi\')</script>';
    const done = render(createElement(OutputView, { output }));
    expect(iframes(done)).toHaveLength(1);
    expect(done).toContain("1 个网页");
    const streaming = render(createElement(OutputView, { output, running: true }));
    expect(iframes(streaming)).toHaveLength(0);
    expect(streaming).not.toContain("网页生成中");
  });

  it("生成中没写语言的 SVG 代码块写到 </svg> 时仍是代码块，围栏关上才当网页", () => {
    const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    for (const partial of [`图标：\n\`\`\`\n${svg}`, `图标：\n\`\`\`\n${svg}\n\`\``]) {
      const markup = render(createElement(OutputView, { output: partial, running: true }));
      expect(markup, partial).toContain('aria-label="复制代码"');
      expect(markup, partial).not.toContain("网页生成中");
    }
    const closed = render(createElement(OutputView, { output: `图标：\n\`\`\`\n${svg}\n\`\`\``, running: true }));
    expect(iframes(closed)).toHaveLength(1);
    expect(closed).not.toContain('aria-label="复制代码"');
  });

  it("分几个围栏讲解一张网页时，说明文字照常显示在网页框外面", () => {
    const output = [
      "先写文档头：",
      "```html",
      "<!DOCTYPE html>",
      "<html>",
      "<head><title>t</title></head>",
      "```",
      "再写主体：",
      "```html",
      "<body><p>x</p></body>",
      "</html>",
      "```",
      "这样就完成了。",
    ].join("\n");
    const markup = render(createElement(OutputView, { output }));
    expect(iframes(markup)).toHaveLength(2);
    expect(markup).toContain(">再写主体：</div>");
    expect(markup).toContain(">这样就完成了。</div>");
  });

  it("空输出：生成中显示等待，否则显示空文案", () => {
    expect(render(createElement(OutputView, { output: "", running: true }))).toContain("等待模型输出…");
    expect(render(createElement(OutputView, { output: "  " }))).toContain("（没有输出）");
    expect(render(createElement(OutputView, { output: "", emptyText: "尚未检测" }))).toContain("尚未检测");
  });

  it("思考中：显示展开的思考过程和加载状态", () => {
    const markup = render(createElement(OutputView, { output: "<think>先想想", running: true }));
    expect(markup).toContain("思考过程");
    expect(markup).toContain("思考中");
    expect(markup).toContain("先想想");
    expect(markup).not.toContain("等待模型输出");
  });

  it("上游单独返回的思考过程和 <think> 里的合在一起", () => {
    const markup = render(
      createElement(OutputView, { output: "<think>乙</think>答案", reasoning: "甲" }),
    );
    expect(markup).toContain("思考过程");
    expect(markup).toContain("答案");
    expect(markup).toContain(">2 字<"); // "甲\n\n乙"
  });

  it("只有思考过程、没有正文且已结束时，显示空文案", () => {
    const markup = render(createElement(OutputView, { output: "", reasoning: "想了很久" }));
    expect(markup).toContain("思考过程");
    expect(markup).toContain("（没有输出）");
  });
});

describe("StatusTag", () => {
  it("四种状态的文字各不相同", () => {
    expect(STATUS_LABELS).toEqual({ running: "检测中", success: "成功", error: "失败", timeout: "超时" });
    for (const status of ["running", "success", "error", "timeout"] as const) {
      const markup = renderToStaticMarkup(createElement(StatusTag, { status }));
      expect(markup).toContain(STATUS_LABELS[status]);
      expect(markup).toContain(`data-status="${status}"`);
    }
  });
});
