/**
 * 打开 SQLite 数据库并执行迁移。用 PRAGMA user_version 记录结构版本。
 */
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  endpoint_type TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  extra_headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  stream INTEGER NOT NULL DEFAULT 1,
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  max_tokens INTEGER,
  temperature REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX models_channel ON models(channel_id);
CREATE TABLE model_prompts (
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  PRIMARY KEY (model_id, prompt_id)
);
CREATE INDEX model_prompts_prompt ON model_prompts(prompt_id);
CREATE TABLE results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  prompt_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  stream INTEGER NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  first_token_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  finish_reason TEXT,
  trigger TEXT NOT NULL DEFAULT 'schedule'
);
CREATE INDEX results_check ON results(model_id, prompt_id, id);
CREATE INDEX results_started ON results(started_at);
CREATE INDEX results_prompt ON results(prompt_id);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** 全新的库预置的示例提示词（不分配给任何模型，不会触发检测） */
export const SEED_PROMPTS: ReadonlyArray<{ title: string; content: string }> = [
  {
    title: "小数比较",
    content: "9.11 和 9.9 哪个大？请先给出结论，再用一两句话解释。",
  },
  {
    title: "数字母",
    content: "英文单词 strawberry 里一共有几个字母 r？请逐个字母数一遍再回答。",
  },
  {
    title: "网页时钟",
    content:
      "写一个单文件 HTML 页面：页面中央显示一个会走动的模拟时钟（有时针、分针、秒针和刻度），样式美观。只输出完整的 HTML 代码。",
  },
];

/**
 * 库里有明文的 API 密钥：库文件和 -wal / -shm 只给自己读写（0600），和 session-secret 一样。
 * 新建的文件靠启动时的 umask；这里顺带收紧旧版本建出来的 0644 文件。
 */
function restrictFileModes(file: string): void {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // 文件不存在（还没生成 -wal / -shm）或改不了权限时不影响使用
    }
  }
}

/**
 * 打开数据库：每个连接都开外键约束；文件库用 WAL，并把文件权限收紧到 0600。
 * file 传 ":memory:" 得到内存库（测试用）。
 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (file !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  if (file !== ":memory:") restrictFileModes(file);
  return db;
}

/** 在一个事务里执行 fn；fn 抛错时回滚。不支持嵌套。 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

/**
 * 地址里的用户名密码（scheme://user:pass@host）换成 scheme://***@host。
 * 旧版本把 fetch 拒绝带凭据地址的报错原样存进了结果，里面有明文密码
 */
export function maskUrlUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#\\]+@/gi, "$1***@");
}

/** 渠道基础地址里的用户名密码（已解码），没有时 null */
function splitUserinfo(
  baseUrl: string,
): { baseUrl: string; username: string; password: string } | null {
  const raw = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.username && !url.password) return null;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const username = decode(url.username);
  const password = decode(url.password);
  url.username = "";
  url.password = "";
  let stripped = url.href;
  // 原来只写到域名时，别平白多出一个结尾的 /
  if (url.pathname === "/" && !url.search && !url.hash && !raw.endsWith("/")) {
    stripped = stripped.slice(0, -1);
  }
  return { baseUrl: stripped, username, password };
}

/** 渠道的密钥本来就放在 Authorization 头里的端点类型（额外请求头会顶替它） */
const BEARER_ENDPOINTS = new Set(["openai-chat", "openai-responses"]);

/**
 * 版本 2：清理旧版本留下的凭据。
 * - 基础地址里带 user:pass@ 的渠道（fetch 不接受这种地址，渠道一直是坏的）：去掉地址里的用户名密码，
 *   额外请求头里还没有 Authorization 时改成 Authorization: Basic …，渠道能直接用上
 * - 结果报错里带出来的地址凭据打码（公开接口会返回这些报错）
 * 返回给管理员看的提示（不含密钥），由调用方在事务提交后打印
 */
function migrateV2(db: DatabaseSync): string[] {
  const notices: string[] = [];
  const now = new Date().toISOString();
  const channels = db
    .prepare(
      "SELECT id, name, endpoint_type, base_url, api_key, extra_headers FROM channels WHERE base_url LIKE '%@%'",
    )
    .all();
  const updateChannel = db.prepare(
    "UPDATE channels SET base_url = ?, extra_headers = ?, updated_at = ? WHERE id = ?",
  );
  for (const row of channels) {
    const split = splitUserinfo(String(row.base_url));
    if (!split) continue;
    let headers: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(String(row.extra_headers));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        headers = parsed as Record<string, unknown>;
      }
    } catch {
      // 读不出来的额外请求头按空处理（repo 读取时也是这样）
    }
    const label = `渠道 #${String(row.id)}「${String(row.name)}」`;
    const hasAuthorization = Object.keys(headers).some(
      (name) => name.trim().toLowerCase() === "authorization",
    );
    let notice: string;
    if (hasAuthorization) {
      notice = `${label}的基础地址里带了用户名和密码，已去掉；额外请求头里已有 Authorization，保持不变`;
    } else {
      const token = Buffer.from(
        `${split.username}:${split.password}`,
        "utf8",
      ).toString("base64");
      headers = { ...headers, Authorization: `Basic ${token}` };
      notice = `${label}的基础地址里带了用户名和密码，已移到额外请求头 Authorization: Basic …`;
      if (
        BEARER_ENDPOINTS.has(String(row.endpoint_type)) &&
        String(row.api_key).trim() !== ""
      ) {
        notice +=
          "（注意：这个端点类型的 API 密钥也是放在 Authorization 头里发的，现在会被这个 Basic 头顶替，请到后台检查）";
      }
    }
    updateChannel.run(
      split.baseUrl,
      JSON.stringify(headers),
      now,
      Number(row.id),
    );
    notices.push(notice);
  }

  const results = db
    .prepare("SELECT id, error FROM results WHERE error LIKE '%://%@%'")
    .all();
  const updateError = db.prepare("UPDATE results SET error = ? WHERE id = ?");
  for (const row of results) {
    const error = String(row.error);
    const masked = maskUrlUserinfo(error);
    if (masked !== error) updateError.run(masked, Number(row.id));
  }
  return notices;
}

export function migrate(db: DatabaseSync): void {
  const version = getUserVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `数据库结构版本 ${version} 比程序支持的 ${SCHEMA_VERSION} 新，请升级程序`,
    );
  }
  if (version >= SCHEMA_VERSION) return;

  const notices = transaction(db, () => {
    const out: string[] = [];
    if (version < 1) {
      db.exec(SCHEMA_V1);
      // 只在从零建库时预置示例，之后管理员删掉了也不会再冒出来
      const now = new Date().toISOString();
      const insert = db.prepare(
        "INSERT INTO prompts (title, content, enabled, sort_order, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)",
      );
      SEED_PROMPTS.forEach((prompt, index) => {
        insert.run(prompt.title, prompt.content, index, now, now);
      });
    }
    if (version < 2) out.push(...migrateV2(db));
    // user_version 不能用参数绑定
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return out;
  });
  // 事务提交后再打印，回滚了就不会留下误导的提示
  for (const notice of notices) console.warn(`[db] ${notice}`);
}
