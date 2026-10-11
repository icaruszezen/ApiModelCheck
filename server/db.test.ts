import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getUserVersion,
  migrate,
  openDatabase,
  SCHEMA_VERSION,
  SEED_PROMPTS,
  transaction,
} from "./db.ts";

const opened: { close(): void }[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // 测试里可能已经关过
    }
  }
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function open(file = ":memory:") {
  const db = openDatabase(file);
  opened.push(db);
  return db;
}

describe("openDatabase / migrate", () => {
  it("建好全部表并把版本号设为当前版本", () => {
    const db = open();
    expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "channels",
        "prompts",
        "models",
        "model_prompts",
        "results",
        "settings",
      ]),
    );
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["results_check", "results_started"]),
    );
  });

  it("开启了外键约束", () => {
    const db = open();
    expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO models (channel_id, model, created_at, updated_at) VALUES (999, 'x', '', '')",
        )
        .run(),
    ).toThrow();
  });

  it("全新的库预置三条示例提示词，且不分配给任何模型", () => {
    const db = open();
    const prompts = db
      .prepare(
        "SELECT title, content, enabled FROM prompts ORDER BY sort_order, id",
      )
      .all();
    expect(prompts.map((row) => row.title)).toEqual([
      "小数比较",
      "数字母",
      "网页时钟",
    ]);
    expect(prompts.map((row) => row.content)).toEqual(
      SEED_PROMPTS.map((p) => p.content),
    );
    expect(prompts.every((row) => row.enabled === 1)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_prompts").get()?.n).toBe(
      0,
    );
  });

  it("已经迁移过的库再次迁移时不会重复预置", () => {
    const db = open();
    db.exec("DELETE FROM prompts");
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM prompts").get()?.n).toBe(0);
  });

  it("文件库重新打开时保留数据、不重复预置，并使用 WAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "amc-db-"));
    tempDirs.push(dir);
    const file = join(dir, "app.db");
    const first = openDatabase(file);
    expect(first.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
      "wal",
    );
    first.exec("DELETE FROM prompts WHERE title = '数字母'");
    first.close();

    const second = open(file);
    const titles = second
      .prepare("SELECT title FROM prompts ORDER BY id")
      .all()
      .map((r) => r.title);
    expect(titles).toEqual(["小数比较", "网页时钟"]);
  });

  it("库的版本比程序新时拒绝打开", () => {
    const dir = mkdtempSync(join(tmpdir(), "amc-db-"));
    tempDirs.push(dir);
    const file = join(dir, "app.db");
    const db = openDatabase(file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(file)).toThrow(/版本/);
  });
});

describe("transaction", () => {
  it("出错时回滚", () => {
    const db = open();
    expect(() =>
      transaction(db, () => {
        db.exec("DELETE FROM prompts");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM prompts").get()?.n).toBe(3);
  });
});
