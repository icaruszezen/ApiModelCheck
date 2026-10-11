import { describe, expect, it } from "vitest";
import { parseOutput, type OutputSegment } from "./output-parse.ts";

const CLOCK_DOC = [
  "<!DOCTYPE html>",
  '<html lang="zh">',
  "<head><title>时钟</title><style>body{margin:0}</style></head>",
  "<body><canvas id=c></canvas><script>tick()</script></body>",
  "</html>",
].join("\n");

/** 预览 Markdown 的网页：脚本的模板字符串里有单独一行的 ``` */
const MD_DOC = [
  "<!DOCTYPE html>",
  '<html><body><pre id="o"></pre><script>',
  "const md = `",
  "# 标题",
  "```js",
  "console.log(1)",
  "```",
  "`;",
  "document.getElementById('o').textContent = md;",
  "</script></body></html>",
].join("\n");

const segments = (output: string, running = false) => parseOutput(output, { running }).segments;

describe("parseOutput：纯文字", () => {
  it("普通文字原样作为一段 text", () => {
    expect(parseOutput("9.9 比 9.11 大。\n\n因为 0.9 > 0.11。")).toEqual({
      reasoning: "",
      reasoningOpen: false,
      segments: [{ kind: "text", text: "9.9 比 9.11 大。\n\n因为 0.9 > 0.11。" }],
    });
  });

  it("空输出、只有空白的输出没有任何段", () => {
    expect(parseOutput("")).toEqual({ reasoning: "", reasoningOpen: false, segments: [] });
    expect(parseOutput("  \n\t\n ")).toEqual({ reasoning: "", reasoningOpen: false, segments: [] });
    expect(segments("", true)).toEqual([]);
  });

  it("文字段去掉首尾空行，但保留中间的换行和第一行的缩进", () => {
    expect(segments("\n\n  第一行\n\n\n第二行  \n\n")).toEqual([
      { kind: "text", text: "  第一行\n\n\n第二行" },
    ]);
  });

  it("提到 <html> 元素的说明文字不是网页", () => {
    const prose = "网页的根元素是 <html> 元素，所有内容都写在它里面。";
    expect(segments(prose)).toEqual([{ kind: "text", text: prose }]);
    const more = "用 <html> 元素包住全部内容，再在里面放 <head> 和 <body> 两部分。";
    expect(segments(more)).toEqual([{ kind: "text", text: more }]);
  });

  it("提到 <!DOCTYPE html> 声明的说明文字不是网页", () => {
    const inline = "每个页面的第一行都应该写 `<!DOCTYPE html>`，然后才是 `<html>`。";
    expect(segments(inline)).toEqual([{ kind: "text", text: inline }]);
    const bare = "第一行写 <!DOCTYPE html> 声明，浏览器才会用标准模式渲染。";
    expect(segments(bare)).toEqual([{ kind: "text", text: bare }]);
    const tail = "页面要以 <!DOCTYPE html>";
    expect(segments(tail)).toEqual([{ kind: "text", text: tail }]);
  });

  it("以 < 开头但不像网页的整段文字仍是文字", () => {
    expect(segments("<b>9.9</b> 更大")).toEqual([{ kind: "text", text: "<b>9.9</b> 更大" }]);
    expect(segments("<p>你好</p>")).toEqual([{ kind: "text", text: "<p>你好</p>" }]);
  });
});

describe("parseOutput：围栏代码块", () => {
  it("夹在文字中间的 ```html 围栏是网页", () => {
    const output = "下面是页面：\n\n```html\n<div class=\"a\">hi</div>\n<style>.a{color:red}</style>\n```\n\n打开就能看到。";
    expect(segments(output)).toEqual([
      { kind: "text", text: "下面是页面：" },
      {
        kind: "html",
        html: '<div class="a">hi</div>\n<style>.a{color:red}</style>',
        complete: true,
        source: "fence",
      },
      { kind: "text", text: "打开就能看到。" },
    ]);
  });

  it("语言标记不分大小写，htm / xhtml / svg 也是网页，语言后面的附加信息忽略", () => {
    expect(segments("```HTML\n<p>x</p>\n```")[0]).toMatchObject({ kind: "html", source: "fence" });
    expect(segments("```htm\n<p>x</p>\n```")[0]).toMatchObject({ kind: "html" });
    expect(segments("```xhtml\n<p>x</p>\n```")[0]).toMatchObject({ kind: "html" });
    expect(segments('```html title="index.html"\n<p>x</p>\n```')[0]).toMatchObject({
      kind: "html",
      html: "<p>x</p>",
    });
  });

  it("svg 围栏是网页", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    expect(segments(`画好了：\n\`\`\`svg\n${svg}\n\`\`\``)).toEqual([
      { kind: "text", text: "画好了：" },
      { kind: "html", html: svg, complete: true, source: "fence" },
    ]);
  });

  it("没写语言、内容是完整文档的围栏也是网页", () => {
    expect(segments("```\n" + CLOCK_DOC + "\n```")).toEqual([
      { kind: "html", html: CLOCK_DOC, complete: true, source: "fence" },
    ]);
    expect(segments("```xml\n<html>\n<body>x</body>\n</html>\n```")[0]).toMatchObject({
      kind: "html",
      source: "fence",
    });
    expect(segments("```text\n<!-- 首页 -->\n<!doctype html><p>x</p>\n```")[0]).toMatchObject({
      kind: "html",
    });
  });

  it("没写语言、内容不是完整文档的围栏是代码", () => {
    expect(segments("```\n<div>x</div>\n```")).toEqual([
      { kind: "code", lang: "", code: "<div>x</div>", complete: true },
    ]);
  });

  it("其他语言的围栏是代码，语言标记原样保留", () => {
    const output = "解法：\n```Python\nprint('hi')\n\nprint(<html>)\n```\n结束";
    expect(segments(output)).toEqual([
      { kind: "text", text: "解法：" },
      { kind: "code", lang: "Python", code: "print('hi')\n\nprint(<html>)", complete: true },
      { kind: "text", text: "结束" },
    ]);
    expect(segments("```js\n" + CLOCK_DOC + "\n```")[0]).toMatchObject({ kind: "code", lang: "js" });
  });

  it("~~~ 围栏和 ``` 一样，但不会被另一种字符关闭", () => {
    expect(segments("~~~html\n<p>a</p>\n```\n<p>b</p>\n~~~\n后记")).toEqual([
      { kind: "html", html: "<p>a</p>\n```\n<p>b</p>", complete: true, source: "fence" },
      { kind: "text", text: "后记" },
    ]);
  });

  it("关闭围栏可以比开头长，但不能比开头短", () => {
    expect(segments("````md\n```js\nx\n```\n`````\n尾巴")).toEqual([
      { kind: "code", lang: "md", code: "```js\nx\n```", complete: true },
      { kind: "text", text: "尾巴" },
    ]);
  });

  it("最多缩进 3 格的围栏有效，内容去掉同样多的缩进；缩进 4 格不是围栏", () => {
    expect(segments("1. 代码：\n   ```js\n   let a = 1;\n     b();\n   ```\n")).toEqual([
      { kind: "text", text: "1. 代码：" },
      { kind: "code", lang: "js", code: "let a = 1;\n  b();", complete: true },
    ]);
    expect(segments("    ```js\n    x\n    ```")).toEqual([
      { kind: "text", text: "    ```js\n    x\n    ```" },
    ]);
  });

  it("``` 开头、信息串里还有反引号的是行内代码，不是围栏", () => {
    expect(segments("```js``` 是行内写法")).toEqual([{ kind: "text", text: "```js``` 是行内写法" }]);
  });

  it("生成中没闭合的围栏 complete 为 false", () => {
    expect(segments("页面如下：\n```html\n<!DOCTYPE html>\n<html><body><h1>半", true)).toEqual([
      { kind: "text", text: "页面如下：" },
      { kind: "html", html: "<!DOCTYPE html>\n<html><body><h1>半", complete: false, source: "fence" },
    ]);
    expect(segments("```python\nprint(1)\n", true)).toEqual([
      { kind: "code", lang: "python", code: "print(1)", complete: false },
    ]);
  });

  it("生成结束了围栏还没闭合（输出被截断），同样 complete 为 false", () => {
    expect(segments("```html\n<div>\n<p>截断")).toEqual([
      { kind: "html", html: "<div>\n<p>截断", complete: false, source: "fence" },
    ]);
  });

  it("空的围栏", () => {
    expect(segments("```js\n```")).toEqual([{ kind: "code", lang: "js", code: "", complete: true }]);
    expect(segments("```html", true)).toEqual([
      { kind: "html", html: "", complete: false, source: "fence" },
    ]);
  });

  it("两个网页围栏各成一段", () => {
    const output = "方案一：\n```html\n<div>一</div>\n```\n方案二：\n```html\n<div>二</div>\n```";
    expect(segments(output)).toEqual([
      { kind: "text", text: "方案一：" },
      { kind: "html", html: "<div>一</div>", complete: true, source: "fence" },
      { kind: "text", text: "方案二：" },
      { kind: "html", html: "<div>二</div>", complete: true, source: "fence" },
    ]);
  });

  it("网页文档里单独一行的 ```（脚本字符串里的 Markdown 示例）不会提前结束围栏", () => {
    expect(segments(`Markdown 预览页：\n\`\`\`html\n${MD_DOC}\n\`\`\`\n以上。`)).toEqual([
      { kind: "text", text: "Markdown 预览页：" },
      { kind: "html", html: MD_DOC, complete: true, source: "fence" },
      { kind: "text", text: "以上。" },
    ]);
    // 没写语言的文档围栏一样；</html> 和关闭行之间可以隔着空行
    expect(segments(`\`\`\`\n${MD_DOC}\n\n\`\`\`\n以上。`)).toEqual([
      { kind: "html", html: `${MD_DOC}\n`, complete: true, source: "fence" },
      { kind: "text", text: "以上。" },
    ]);
  });

  it("</html> 后面紧跟的不是关闭行时，照常在第一个关闭行结束", () => {
    expect(segments("```html\n<!DOCTYPE html>\n<html><body>\n```\n页面最后写上 </html> 就行。")).toEqual([
      { kind: "html", html: "<!DOCTYPE html>\n<html><body>", complete: true, source: "fence" },
      { kind: "text", text: "页面最后写上 </html> 就行。" },
    ]);
    // 其他语言的围栏不看 </html>
    expect(segments("```md\n<!DOCTYPE html>\n```\n</html>\n```")[0]).toEqual({
      kind: "code",
      lang: "md",
      code: "<!DOCTYPE html>",
      complete: true,
    });
  });

  it("文档围栏里的关闭行不在脚本之类的元素里时，照常结束，不会把后面的说明并进网页", () => {
    // 分三个围栏讲解一张网页：</html> 在最后一个围栏里
    const tutorial = [
      "第一步，先写文档头：",
      "",
      "```html",
      "<!DOCTYPE html>",
      "<html>",
      "<head>",
      '  <meta charset="UTF-8">',
      "```",
      "",
      "第二步，在 head 里加样式：",
      "",
      "```html",
      "  <style>body{margin:0}</style>",
      "</head>",
      "```",
      "",
      "第三步，写 body 并收尾：",
      "",
      "```html",
      "<body>",
      "  <div>你好</div>",
      "</body>",
      "</html>",
      "```",
      "",
      "这样就完成了。",
    ].join("\n");
    const page = (html: string) => ({ kind: "html", html, complete: true, source: "fence" });
    expect(segments(tutorial)).toEqual([
      { kind: "text", text: "第一步，先写文档头：" },
      page('<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="UTF-8">'),
      { kind: "text", text: "第二步，在 head 里加样式：" },
      page("  <style>body{margin:0}</style>\n</head>"),
      { kind: "text", text: "第三步，写 body 并收尾：" },
      page("<body>\n  <div>你好</div>\n</body>\n</html>"),
      { kind: "text", text: "这样就完成了。" },
    ]);

    // 忘了写 </html>，后面另起一个围栏补上
    const forgot = "```html\n<!DOCTYPE html>\n<html>\n<body>\n<p>hi</p>\n</body>\n```\n\n注意结尾要补上：\n\n```html\n</html>\n```";
    expect(segments(forgot)).toEqual([
      page("<!DOCTYPE html>\n<html>\n<body>\n<p>hi</p>\n</body>"),
      { kind: "text", text: "注意结尾要补上：" },
      page("</html>"),
    ]);

    // 说明文字里提到 </html>，后面还有一个没写语言的代码块
    const prose = "```html\n<!DOCTYPE html>\n<html><body>hi</body>\n```\n说明：文档最后一行是 </html>\n```\nnpm start\n```";
    expect(segments(prose)).toEqual([
      page("<!DOCTYPE html>\n<html><body>hi</body>"),
      { kind: "text", text: "说明：文档最后一行是 </html>" },
      { kind: "code", lang: "", code: "npm start", complete: true },
    ]);

    // 脚本在关闭行之前已经关上了：关闭行也不在网页的文字里
    const closed = "```html\n<!DOCTYPE html>\n<html><body><script>go()</script>\n```\n最后写 </html>\n```";
    expect(segments(closed)[0]).toEqual(page("<!DOCTYPE html>\n<html><body><script>go()</script>"));
  });

  it("文本框、<pre>、<template> 里单独一行的 ``` 同样不会提前结束文档围栏", () => {
    for (const [open, close] of [
      ["<textarea id=t>", "</textarea>"],
      ["<pre>", "</pre>"],
      ['<template id="md">', "</template>"],
      ["<style>/*", "*/</style>"],
    ]) {
      const doc = `<!DOCTYPE html>\n<html><body>${open}\n# 示例\n\`\`\`\nx\n\`\`\`\n${close}</body></html>`;
      expect(segments(`\`\`\`html\n${doc}\n\`\`\`\n以上。`), open).toEqual([
        { kind: "html", html: doc, complete: true, source: "fence" },
        { kind: "text", text: "以上。" },
      ]);
    }
    // 脚本里的 "<style>" 字符串不算打开了样式，脚本关上后就不在里面了
    const quoted = "```html\n<!DOCTYPE html>\n<html><body><script>const s = '<style>';</script>\n```\n</body></html>\n```";
    expect(segments(quoted)[0]).toEqual({
      kind: "html",
      html: "<!DOCTYPE html>\n<html><body><script>const s = '<style>';</script>",
      complete: true,
      source: "fence",
    });
  });

  it("紧挨着的两个网页围栏不会并成一个", () => {
    const one = "<!DOCTYPE html>\n<html><body>1</body></html>";
    const two = "<!DOCTYPE html>\n<html><body>2</body></html>";
    const fence = (html: string) => `\`\`\`html\n${html}\n\`\`\``;
    const page = (html: string) => ({ kind: "html", html, complete: true, source: "fence" });
    expect(segments(`${fence(one)}\n${fence(two)}`)).toEqual([page(one), page(two)]);
    // 第一个文档没写 </html>，也不会跨进第二个文档里去找
    const bare = "<!DOCTYPE html>\n<body>1</body>";
    expect(segments(`${fence(bare)}\n${fence(two)}`)).toEqual([page(bare), page(two)]);
    // 片段围栏
    expect(segments(`${fence("<div>一</div>")}\n${fence("<div>二</div>")}`)).toEqual([
      page("<div>一</div>"),
      page("<div>二</div>"),
    ]);
    expect(segments(`${fence("<div>一</div>")}\n${fence(two)}`)).toEqual([page("<div>一</div>"), page(two)]);
  });

  it("没写语言（或 xml / markup / text）、内容整个是一张 SVG 的围栏也是网页", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <circle cx="5" cy="5" r="4"/>\n</svg>';
    for (const lang of ["", "xml", "XML", "markup", "text", "plaintext"]) {
      expect(segments(`画好了：\n\`\`\`${lang}\n${svg}\n\`\`\``)).toEqual([
        { kind: "text", text: "画好了：" },
        { kind: "html", html: svg, complete: true, source: "fence" },
      ]);
    }
    const declared = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- 图标 -->\n${svg}\n`;
    expect(segments(`\`\`\`xml\n${declared}\n\`\`\``)).toEqual([
      { kind: "html", html: declared, complete: true, source: "fence" },
    ]);
  });

  it("不是整个一张 SVG 的围栏仍是代码", () => {
    expect(segments("```xml\n<note><to>x</to></note>\n```")[0]).toMatchObject({ kind: "code", lang: "xml" });
    expect(segments("```\n<svg><rect/></svg>\n<p>后面还有</p>\n```")[0]).toMatchObject({ kind: "code" });
    expect(segments("```\n<p>前面有</p>\n<svg><rect/></svg>\n```")[0]).toMatchObject({ kind: "code" });
    expect(segments("```js\n<svg><rect/></svg>\n```")[0]).toMatchObject({ kind: "code", lang: "js" });
    expect(segments("```\n<svgx></svg>\n```")[0]).toMatchObject({ kind: "code" });
    // 还没写到 </svg>
    expect(segments("```\n<svg><rect/>", true)[0]).toMatchObject({ kind: "code", complete: false });
  });

  it("生成中没写语言的 SVG 围栏：关上之前一直是代码，关上之后才是网页，不来回变", () => {
    const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    for (const [lang, body] of [
      ["", svg],
      ["xml", `${svg}\n${svg}`],
    ]) {
      const output = `图标：\n\`\`\`${lang}\n${body}\n\`\`\`\n就是这样。`;
      const closeAt = output.lastIndexOf("```") + 3;
      const kinds: string[] = [];
      for (let size = 1; size <= output.length; size++) {
        const fence = segments(output.slice(0, size), true)[1];
        if (!fence) continue;
        const kind = `${fence.kind}${fence.kind !== "text" && fence.complete ? "" : "~"}`;
        if (kinds[kinds.length - 1] !== kind) kinds.push(kind);
        // 关闭行写全之前都是代码
        if (size < closeAt) expect(fence.kind, output.slice(0, size)).toBe("code");
      }
      expect(kinds).toEqual(["code~", "html"]);
      expect(segments(output)[1]).toEqual({ kind: "html", html: body, complete: true, source: "fence" });
    }
    // 生成结束了围栏还没关（输出被截断）：照常认 SVG
    expect(segments(`\`\`\`\n${svg}`)[0]).toEqual({ kind: "html", html: svg, complete: false, source: "fence" });
  });

  it("围栏里的 <!DOCTYPE html> 不会再被当成原始文档", () => {
    expect(segments("```js\nconst page = `\n<!DOCTYPE html><html><head></head><body></body></html>`;\n```")).toEqual([
      {
        kind: "code",
        lang: "js",
        code: "const page = `\n<!DOCTYPE html><html><head></head><body></body></html>`;",
        complete: true,
      },
    ]);
  });
});

describe("parseOutput：围栏以外的原始 HTML 文档", () => {
  it("从一行中间开始的 <!DOCTYPE html>，前后的文字各成一段", () => {
    const output = `好的！下面就是页面：${CLOCK_DOC.replace(/\n/g, "")}希望你喜欢。\n有问题再问我。`;
    expect(segments(output)).toEqual([
      { kind: "text", text: "好的！下面就是页面：" },
      { kind: "html", html: CLOCK_DOC.replace(/\n/g, ""), complete: true, source: "document" },
      { kind: "text", text: "希望你喜欢。\n有问题再问我。" },
    ]);
  });

  it("整个输出就是一个完整文档", () => {
    expect(segments(CLOCK_DOC)).toEqual([
      { kind: "html", html: CLOCK_DOC, complete: true, source: "document" },
    ]);
    expect(segments(`\n\n${CLOCK_DOC}\n`)).toEqual([
      { kind: "html", html: CLOCK_DOC, complete: true, source: "document" },
    ]);
  });

  it("doctype 不分大小写，可以带公共标识符", () => {
    const xhtml =
      '<!doctype HTML PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html><body>x</body></html>';
    expect(segments(`看：\n${xhtml}`)).toEqual([
      { kind: "text", text: "看：" },
      { kind: "html", html: xhtml, complete: true, source: "document" },
    ]);
  });

  it("没有 doctype、以 <html> 开头并带 head / body 的也是文档", () => {
    const doc = '<html lang="en">\n<head><title>t</title></head>\n<body><p>x</p></body>\n</HTML>';
    expect(segments(`页面：\n${doc}\n完毕`)).toEqual([
      { kind: "text", text: "页面：" },
      { kind: "html", html: doc, complete: true, source: "document" },
      { kind: "text", text: "完毕" },
    ]);
  });

  it("<html> 后面没有 head / body 的不是文档", () => {
    const text = "<html>\n<p>只有段落</p>\n</html>";
    expect(segments(text)).toEqual([{ kind: "text", text }]);
  });

  it("文档没写完、生成也已经结束：到结尾为止，complete 为 false", () => {
    const partial = "<!DOCTYPE html>\n<html><head><style>body{}</style></head><body><div>";
    expect(segments(`页面：\n${partial}`)).toEqual([
      { kind: "text", text: "页面：" },
      { kind: "html", html: partial, complete: false, source: "document" },
    ]);
  });

  it("生成中文档才开了个头", () => {
    expect(segments("马上写：\n<!DOCTYPE html", true)).toEqual([
      { kind: "text", text: "马上写：" },
      { kind: "html", html: "<!DOCTYPE html", complete: false, source: "document" },
    ]);
    expect(segments("马上写：\n<!DOCTYPE html>\n", true)).toEqual([
      { kind: "text", text: "马上写：" },
      { kind: "html", html: "<!DOCTYPE html>\n", complete: false, source: "document" },
    ]);
  });

  it("文字里的两个文档各成一段", () => {
    const one = "<!DOCTYPE html><html><body>1</body></html>";
    const two = "<!DOCTYPE html><html><body>2</body></html>";
    expect(segments(`第一版：\n${one}\n第二版：\n${two}`)).toEqual([
      { kind: "text", text: "第一版：" },
      { kind: "html", html: one, complete: true, source: "document" },
      { kind: "text", text: "第二版：" },
      { kind: "html", html: two, complete: true, source: "document" },
    ]);
  });

  it("围栏和原始文档混在一起", () => {
    const doc = "<!DOCTYPE html><html><body>raw</body></html>";
    expect(segments(`先看代码：\n\`\`\`css\nbody{}\n\`\`\`\n再看页面：${doc}`)).toEqual([
      { kind: "text", text: "先看代码：" },
      { kind: "code", lang: "css", code: "body{}", complete: true },
      { kind: "text", text: "再看页面：" },
      { kind: "html", html: doc, complete: true, source: "document" },
    ]);
  });
});

describe("parseOutput：整段都是 HTML 片段", () => {
  it("整段输出是一个片段时当网页", () => {
    const fragment = '<div class="card">\n  <h1>标题</h1>\n</div>\n<style>.card{padding:8px}</style>';
    expect(segments(`\n${fragment}\n\n`)).toEqual([
      { kind: "html", html: fragment, complete: true, source: "fragment" },
    ]);
    const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    expect(segments(svg)).toEqual([{ kind: "html", html: svg, complete: true, source: "fragment" }]);
  });

  it("片段后面还有文字时不算", () => {
    const text = "<div>卡片</div>\n这是一张卡片。";
    expect(segments(text)).toEqual([{ kind: "text", text }]);
  });

  it("生成中以页面标签开头的整段先当没写完的片段", () => {
    expect(segments("<div class=\"a\">\n  <p>还在写", true)).toEqual([
      { kind: "html", html: '<div class="a">\n  <p>还在写', complete: false, source: "fragment" },
    ]);
    // 生成中就算看起来已经写完了也不算完成，写完才渲染
    expect(segments("<div>x</div>", true)).toEqual([
      { kind: "html", html: "<div>x</div>", complete: false, source: "fragment" },
    ]);
    expect(segments("< 不是标签", true)).toEqual([{ kind: "text", text: "< 不是标签" }]);
    expect(segments("<h1>标题</h1>\n<p>还在", true)[0]).toMatchObject({ kind: "html", complete: false });
  });

  it("生成中标签名只写了一半时，是页面标签的前缀也先当没写完的片段", () => {
    for (const html of ["<di", "<!DOC", "<sect", "<TEMPL", "<p"]) {
      expect(segments(html, true)).toEqual([{ kind: "html", html, complete: false, source: "fragment" }]);
    }
    // 只有一个字母时分不出是 <body> 还是 <b>，先当文字：<b>结论</b> 开头的回答从头到尾都是文字
    for (const text of ["<b", "<d", "<a"]) {
      expect(segments(text, true)).toEqual([{ kind: "text", text }]);
    }
    const answer = "<b>结论</b>：9.9 更大";
    for (let size = 1; size <= answer.length; size++) {
      expect(segments(answer.slice(0, size), true)[0]?.kind, answer.slice(0, size)).toBe("text");
    }
  });

  it("生成中以 <!DOCTYPE html> 开头的是没写完的文档", () => {
    expect(segments("<!DOCTYPE html>", true)).toEqual([
      { kind: "html", html: "<!DOCTYPE html>", complete: false, source: "document" },
    ]);
  });

  it("以行内标签、自定义标签开头的回答，生成中和写完都是文字", () => {
    for (const text of [
      "<answer>9.9 更大，因为 0.9 > 0.11",
      "<answer>9.9 更大</answer>\n因为 0.9 > 0.11。",
      "<b>结论</b>：9.9 更大",
      "<reflection>先比较整数部分",
      "<result>9.9</result>",
      "<span",
      "<a href=",
      "<",
      "<!",
    ]) {
      expect(segments(text, true)).toEqual([{ kind: "text", text }]);
      expect(segments(text)).toEqual([{ kind: "text", text }]);
    }
    // 生成中只看开头；写完时整段以 < 开头、> 结尾、带 </div> 这类闭合标签就算片段
    const wrapped = "<answer><div>9.9 更大</div></answer>";
    expect(segments(wrapped, true)).toEqual([{ kind: "text", text: wrapped }]);
    expect(segments(wrapped)).toEqual([{ kind: "html", html: wrapped, complete: true, source: "fragment" }]);
  });

  it("写完时不看开头标签：<button>、<details> 开头、带 </script> / </div> 的片段也是网页", () => {
    for (const html of [
      '<button id="b">点我</button>\n<script>b.onclick=()=>alert(\'hi\')</script>',
      "<details><summary>展开</summary><div>内容</div></details>",
      "<center><h1>你好</h1><div>世界</div></center>",
    ]) {
      expect(segments(html)).toEqual([{ kind: "html", html, complete: true, source: "fragment" }]);
      // 生成中这些开头不在名单里，先显示文字，写完才变成网页
      expect(segments(html, true)).toEqual([{ kind: "text", text: html }]);
    }
    // 没有那几个闭合标签、或者不以 > 结尾的，写完了也是文字
    for (const text of ["<answer>9.9 更大</answer>", "<b>结论</b>：9.9 更大", "<h1>标题</h1>\n<p>正文</p>"]) {
      expect(segments(text)).toEqual([{ kind: "text", text }]);
    }
  });

  it("以 <!DOCTYPE html> 开头的说明文字，生成中和写完都是文字", () => {
    const prose = "<!DOCTYPE html> 是 HTML5 的文档类型声明，它告诉浏览器用标准模式渲染页面。";
    expect(segments(prose)).toEqual([{ kind: "text", text: prose }]);
    expect(segments(prose, true)).toEqual([{ kind: "text", text: prose }]);
    // 声明后面一出现文字就是文字，之后一直是文字
    const firstWord = prose.indexOf("是") + 1;
    for (let size = firstWord; size <= prose.length; size++) {
      const partial = prose.slice(0, size);
      expect(segments(partial, true), partial).toEqual([{ kind: "text", text: partial.trimEnd() }]);
    }
    expect(segments("<!DOCTYPE html>\n这是声明", true)).toEqual([{ kind: "text", text: "<!DOCTYPE html>\n这是声明" }]);
  });

  it("生成中的真网页从 <!D 开始每一步都是网页，不会中途变成文字", () => {
    const page = "<!DOCTYPE html>\n<html><head><title>t</title></head><body><div>hi</div></body></html>";
    for (let size = 3; size < page.length; size++) {
      const partial = page.slice(0, size);
      const parsed = segments(partial, true);
      expect(parsed, partial).toHaveLength(1);
      expect(parsed[0], partial).toMatchObject({ kind: "html", complete: false });
    }
    expect(segments(page)).toEqual([{ kind: "html", html: page, complete: true, source: "document" }]);
  });

  it("开头的 XML 声明、注释之后才看页面标签", () => {
    const commented = "<!-- 卡片 -->\n<div>x</div>";
    expect(segments(commented)).toEqual([
      { kind: "html", html: commented, complete: true, source: "fragment" },
    ]);
    expect(segments("<!-- 卡片 -->\n<di", true)).toEqual([
      { kind: "html", html: "<!-- 卡片 -->\n<di", complete: false, source: "fragment" },
    ]);
    expect(segments("<!-- 卡片", true)).toEqual([{ kind: "text", text: "<!-- 卡片" }]);
    const svg = '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    expect(segments(svg)).toEqual([{ kind: "html", html: svg, complete: true, source: "fragment" }]);
  });
});

describe("parseOutput：思考标签", () => {
  it("开头的 <think>…</think> 是思考过程，之后是正文", () => {
    expect(parseOutput("\n<think>\n先比较整数部分……\n</think>\n\n9.9 更大。")).toEqual({
      reasoning: "先比较整数部分……",
      reasoningOpen: false,
      segments: [{ kind: "text", text: "9.9 更大。" }],
    });
  });

  it("<thinking> 也认，且不分大小写", () => {
    expect(parseOutput("<Thinking>想想</Thinking>答案")).toEqual({
      reasoning: "想想",
      reasoningOpen: false,
      segments: [{ kind: "text", text: "答案" }],
    });
  });

  it("思考之后的正文照常拆段", () => {
    const parsed = parseOutput("<think>要写网页</think>\n```html\n<p>x</p>\n```");
    expect(parsed.reasoning).toBe("要写网页");
    expect(parsed.segments).toEqual([{ kind: "html", html: "<p>x</p>", complete: true, source: "fence" }]);
  });

  it("没有闭合标签：全部算思考过程，reasoningOpen 为 true", () => {
    expect(parseOutput("<think>\n还在想第一步", { running: true })).toEqual({
      reasoning: "还在想第一步",
      reasoningOpen: true,
      segments: [],
    });
    // 生成结束了还没闭合（在思考阶段就被截断）
    expect(parseOutput("<think>想到一半")).toEqual({
      reasoning: "想到一半",
      reasoningOpen: true,
      segments: [],
    });
  });

  it("生成中闭合标签只传了一半时，不把那一截算进思考过程", () => {
    expect(parseOutput("<think>想完了</thi", { running: true })).toEqual({
      reasoning: "想完了",
      reasoningOpen: true,
      segments: [],
    });
  });

  it("生成中开头标签本身还没传完时，先当成正在思考", () => {
    expect(parseOutput("<thi", { running: true })).toEqual({
      reasoning: "",
      reasoningOpen: true,
      segments: [],
    });
    expect(parseOutput("<thinking", { running: true }).reasoningOpen).toBe(true);
  });

  it("开头标签被吞掉、只剩 </think> 时，它之前的是思考过程", () => {
    expect(parseOutput("先算 9.11 和 9.90……\n</think>\n\n9.9 更大。")).toEqual({
      reasoning: "先算 9.11 和 9.90……",
      reasoningOpen: false,
      segments: [{ kind: "text", text: "9.9 更大。" }],
    });
    expect(parseOutput("思考…\n</think>\n\n答案")).toEqual({
      reasoning: "思考…",
      reasoningOpen: false,
      segments: [{ kind: "text", text: "答案" }],
    });
    // 思考过程里写完的代码块不影响
    expect(parseOutput("先写代码：\n```js\nlet a = 1;\n```\n</think>\n\n答案")).toEqual({
      reasoning: "先写代码：\n```js\nlet a = 1;\n```",
      reasoningOpen: false,
      segments: [{ kind: "text", text: "答案" }],
    });
  });

  it("前面出现过 <think> 开头标签时，后面的 </think> 是在谈论标签", () => {
    const text = "推理模型会把思考过程写在 <think> 和 </think> 之间，然后才给出答案。";
    expect(parseOutput(text)).toEqual({
      reasoning: "",
      reasoningOpen: false,
      segments: [{ kind: "text", text }],
    });
    expect(parseOutput("用 <THINKING> 开头、</think> 结尾").reasoning).toBe("");
  });

  it("代码块里的 </think> 不当成思考过程的结束", () => {
    const page =
      "<!DOCTYPE html>\n<html><body><p>推理模型会输出 <b><think></b> … <b></think></b> 两个标签</p></body></html>";
    expect(parseOutput(`示例页面：\n\`\`\`html\n${page}\n\`\`\`\n说明完毕。`)).toEqual({
      reasoning: "",
      reasoningOpen: false,
      segments: [
        { kind: "text", text: "示例页面：" },
        { kind: "html", html: page, complete: true, source: "fence" },
        { kind: "text", text: "说明完毕。" },
      ],
    });
    // 前面没有开头标签、只在代码块里出现的 </think>
    const script = "<script>\nconst close = (r) => `${r}" + "</think>`;\n</script>";
    expect(parseOutput(`\`\`\`html\n${script}\n\`\`\`\n用法见上。`)).toEqual({
      reasoning: "",
      reasoningOpen: false,
      segments: [
        { kind: "html", html: script, complete: true, source: "fence" },
        { kind: "text", text: "用法见上。" },
      ],
    });
  });

  it("没有围栏的网页文档里的 </think> 不当成思考过程的结束", () => {
    const page =
      "<!DOCTYPE html>\n<html><body><script>\nconst r = 'x';\nconst s = `${r}" + "</think>`;\n</script></body></html>";
    for (const output of [page, `网页如下：\n${page}\n就这些。`]) {
      const parsed = parseOutput(output);
      expect(parsed.reasoning).toBe("");
      expect(parsed.segments.filter((segment) => segment.kind === "html")).toEqual([
        { kind: "html", html: page, complete: true, source: "document" },
      ]);
    }
    // 生成中文档还没写到 </html>
    const partial = page.slice(0, page.indexOf("</script>"));
    expect(parseOutput(partial, { running: true })).toEqual({
      reasoning: "",
      reasoningOpen: false,
      segments: [{ kind: "html", html: partial, complete: false, source: "document" }],
    });
    // 文档之前、文档之外的 </think> 照常算：开头标签被吞掉的思考过程后面跟着网页
    expect(parseOutput(`要写一个页面。\n</think>\n${page}`)).toEqual({
      reasoning: "要写一个页面。",
      reasoningOpen: false,
      segments: [{ kind: "html", html: page, complete: true, source: "document" }],
    });
    const done = "<!DOCTYPE html><html><body>草稿</body></html>";
    expect(parseOutput(`先打个草稿：${done}\n</think>\n答案`).reasoning).toBe(`先打个草稿：${done}`);
  });

  it("文字里谈到 `</think>` 标签时不当成思考过程的结束", () => {
    const text = "模型会用 `</think>` 结束思考。";
    expect(parseOutput(text)).toEqual({
      reasoning: "",
      reasoningOpen: false,
      segments: [{ kind: "text", text }],
    });
  });

  it("不在开头的 <think> 不算思考标签", () => {
    const text = "答案：<think> 是一个标签";
    expect(parseOutput(text).reasoning).toBe("");
    expect(parseOutput(text).segments).toEqual([{ kind: "text", text }]);
  });
});

describe("parseOutput：换行符", () => {
  it("CRLF 和单独的 CR 都按换行处理", () => {
    const output = "说明\r\n\r\n```html\r\n<p>x</p>\r\n```\r\n结尾\rEND";
    expect(segments(output)).toEqual<OutputSegment[]>([
      { kind: "text", text: "说明" },
      { kind: "html", html: "<p>x</p>", complete: true, source: "fence" },
      { kind: "text", text: "结尾\nEND" },
    ]);
    expect(parseOutput("<think>\r\n想\r\n</think>\r\n答").reasoning).toBe("想");
  });
});

describe("parseOutput：病态输入不会卡住", () => {
  // 回退成指数 / 平方复杂度时，这几条会超过 vitest 的 5 秒超时
  it("围栏里一长串注释、后面没有文档", () => {
    const output = "```\n" + "<!-- 注释 -->".repeat(60) + "x\n```";
    expect(segments(output)).toEqual([
      { kind: "code", lang: "", code: "<!-- 注释 -->".repeat(60) + "x", complete: true },
    ]);
  });

  it("成千上万个像文档开头又不是文档的片段", () => {
    expect(segments("<html><body>".repeat(60000))[0]?.kind).toBe("text");
    expect(segments("<html><p>".repeat(60000))[0]?.kind).toBe("text");
    expect(segments("<html ".repeat(60000))[0]?.kind).toBe("text");
    expect(segments("<!doctype html ".repeat(60000))[0]?.kind).toBe("text");
  });

  it("成千上万个代码块里的 </think>、文档围栏里的关闭行", () => {
    expect(parseOutput("```\n</think>\n```\n".repeat(30000)).reasoning).toBe("");
    expect(segments("```html\n<html>\n```\n".repeat(30000))).toHaveLength(30000);
    expect(segments("```html\n<html>\n```\n</html>\n".repeat(20000))).toHaveLength(40000);
  });

  it("成千上万个原始文档里的 </think>、文档围栏里的脚本标签", () => {
    const doc = "<!DOCTYPE html><html><body><script>s=`${r}</think>`</script></body></html>\n";
    expect(parseOutput(doc.repeat(20000)).reasoning).toBe("");
    const one = "<!DOCTYPE html>\n<html><body><script>\n" + "x=`${r}</think>`;\n".repeat(50000);
    expect(parseOutput(one).reasoning).toBe("");
    expect(segments("```html\n<!DOCTYPE html>\n<script><style><pre>\n```\n".repeat(20000))).toHaveLength(20000);
  });
});
