/**
 * 打开 SQLite 数据库并执行迁移。用 PRAGMA user_version 记录结构版本。
 */
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

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
 * 打开数据库：每个连接都开外键约束；文件库用 WAL。
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

export function migrate(db: DatabaseSync): void {
  const version = getUserVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `数据库结构版本 ${version} 比程序支持的 ${SCHEMA_VERSION} 新，请升级程序`,
    );
  }
  if (version >= SCHEMA_VERSION) return;

  transaction(db, () => {
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
    // user_version 不能用参数绑定
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}
