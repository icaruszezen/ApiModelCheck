/**
 * 把模型写的 HTML 变成沙箱 iframe 的 srcdoc，以及展示网页时用到的几个小工具。纯函数，方便单测。
 */
import type { OutputSegment } from "../../../../shared/output-parse.ts";

export type HtmlSource = Extract<OutputSegment, { kind: "html" }>["source"];

/**
 * iframe 的沙箱权限：只许跑脚本。
 * 绝不能加 allow-same-origin——加了之后模型写的脚本就和本站同源，能读写本站的一切。
 * 也不加 allow-popups / allow-forms / allow-top-navigation / allow-modals。
 */
export const SANDBOX_POLICY = "allow-scripts";

const FRAGMENT_HEAD =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
const FRAGMENT_TAIL = "</body></html>";

/**
 * 沙箱里的文档是不透明源，一碰 localStorage / sessionStorage 就抛 SecurityError，
 * 用到它们的网页（待办清单、记分的小游戏）会整个跑不起来。换成只存在内存里的替身，
 * 本来就能用的时候不动。
 */
export const STORAGE_SHIM =
  "<script>(function(){function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},key:function(i){var k=Object.keys(d);return i>=0&&i<k.length?k[i]:null},getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('')}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(e2){}}})})();</script>";

/** 文档开头的 doctype（前面可以有空白、注释、XML 声明）。注释体不跨过 -->，免得回溯爆炸 */
const LEADING_DOCTYPE = /^(?:\s|<!--(?:(?!-->)[\s\S])*-->|<\?[^>]*>)*<!doctype[^>]*>/i;

/** 内容自己就是完整文档（有 <html> 或 doctype），不用再包一层 */
export function isFullDocument(html: string): boolean {
  return /<!doctype\s+html|<html(?=[\s>]|$)/i.test(html);
}

/**
 * 在文档最前面放进替身脚本。有 doctype 时放在它后面：
 * doctype 之前出现任何标签，浏览器都会改用怪异模式渲染。
 */
export function injectSandboxShims(doc: string): string {
  const doctype = LEADING_DOCTYPE.exec(doc);
  const at = doctype ? doctype[0].length : 0;
  return doc.slice(0, at) + STORAGE_SHIM + doc.slice(at);
}

/**
 * 生成 srcdoc：完整文档原样使用（只在开头补上替身脚本）；
 * 片段（source 为 fragment，或者围栏里的内容不是完整文档）包一层最小的文档骨架。
 */
export function buildSrcDoc(html: string, source: HtmlSource): string {
  if (source === "document" || (source === "fence" && isFullDocument(html))) {
    return injectSandboxShims(html);
  }
  return `${FRAGMENT_HEAD}${STORAGE_SHIM}</head><body>${html}${FRAGMENT_TAIL}`;
}

/** UTF-8 字节数 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 812 → "812 B"，3277 → "3.2 KB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 最后 count 行，以及前面省掉了几行 */
export function tailLines(text: string, count: number): { text: string; omitted: number } {
  const lines = text.split("\n");
  if (lines.length <= count) return { text, omitted: 0 };
  return { text: lines.slice(-count).join("\n"), omitted: lines.length - count };
}

/** 字数：按码点数（中文、emoji 都算一个），不算空白 */
export function countChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!/\s/.test(char)) count++;
  }
  return count;
}
