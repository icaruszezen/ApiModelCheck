/**
 * 生产环境托管 vite build 的产物（dist/web）。
 * - /assets/* 带内容哈希，长期缓存；找不到就 404（不能回退成 index.html，否则浏览器会把 HTML 当脚本解析）。
 * - 其余找不到的路径回退到 index.html，交给前端路由。
 * - 目录不存在（开发模式，前端由 Vite 提供）时返回一段纯文本说明。
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";

export const DEV_NOTICE = [
  "前端还没有构建，这里只提供 /api 接口。",
  "开发时请打开 Vite 开发服务器（npm run dev，默认 http://localhost:5173）；",
  "部署时先运行 npm run build 生成 dist/web，再启动服务。",
].join("\n");

const IMMUTABLE = "public, max-age=31536000, immutable";

interface FoundFile {
  path: string;
  size: number;
  mtimeMs: number;
}

async function findFile(path: string): Promise<FoundFile | null> {
  try {
    const info = await stat(path);
    return info.isFile()
      ? { path, size: info.size, mtimeMs: info.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

/** 把请求路径映射到 root 下的文件路径；含 .. 等越界写法时返回 null */
function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const target = resolve(
    root,
    `.${decoded.startsWith("/") ? "" : "/"}${decoded}`,
  );
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".."))
    return null;
  return target;
}

function etagOf(file: FoundFile): string {
  return `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
}

async function sendFile(
  c: Context,
  file: FoundFile,
  cacheControl: string,
): Promise<Response> {
  const etag = etagOf(file);
  const headers: Record<string, string> = {
    "Content-Type": getMimeType(file.path) ?? "application/octet-stream",
    "Cache-Control": cacheControl,
    ETag: etag,
  };
  const ifNoneMatch = c.req.header("if-none-match");
  if (
    ifNoneMatch &&
    ifNoneMatch.split(",").some((tag) => tag.trim() === etag)
  ) {
    return new Response(null, { status: 304, headers });
  }
  const body = await readFile(file.path);
  headers["Content-Length"] = String(body.byteLength);
  return new Response(c.req.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

/**
 * root 为 null（或里面没有 index.html）时进入开发模式，返回纯文本说明。
 */
export function createStaticHandler(root: string | null) {
  const absRoot = root ? resolve(root) : null;

  return async (c: Context): Promise<Response> => {
    const index = absRoot ? await findFile(join(absRoot, "index.html")) : null;
    if (!absRoot || !index) {
      return c.text(DEV_NOTICE, 200, { "Cache-Control": "no-store" });
    }

    const path = c.req.path;
    const target = resolveInside(absRoot, path);
    const isAsset = path.startsWith("/assets/");
    const file = target && !path.endsWith("/") ? await findFile(target) : null;

    if (file) {
      return sendFile(c, file, isAsset ? IMMUTABLE : "no-cache");
    }
    if (isAsset) {
      return c.text("文件不存在", 404, { "Cache-Control": "no-store" });
    }
    return sendFile(c, index, "no-cache");
  };
}
