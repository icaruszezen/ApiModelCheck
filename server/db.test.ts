import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { baseUrlIssue } from "../shared/endpoints.ts";
import {
  getUserVersion,
  maskUrlUserinfo,
  migrate,
  openDatabase,
  SCHEMA_VERSION,
  SEED_PROMPTS,
  transaction,
} from "./db.ts";

const opened: { close(): void }[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

  it("库文件和 -wal / -shm 的权限收紧到 0600，旧的 0644 文件也改掉", () => {
    const dir = mkdtempSync(join(tmpdir(), "amc-db-"));
    tempDirs.push(dir);
    const file = join(dir, "app.db");
    const mode = (path: string) => statSync(path).mode & 0o777;
    // 模拟旧版本在默认 umask 下建出来的库
    writeFileSync(file, "", { mode: 0o644 });
    chmodSync(file, 0o644);
    const db = open(file);
    db.exec("INSERT INTO settings (key, value) VALUES ('k', 'v')");
    expect(mode(file)).toBe(0o600);
    for (const extra of [`${file}-wal`, `${file}-shm`]) {
      expect(existsSync(extra)).toBe(true);
      expect(mode(extra)).toBe(0o600);
    }
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

describe("版本 2 迁移：清理旧版本留下的凭据", () => {
  const OLD = "2025-01-01T00:00:00.000Z";

  function insertChannel(
    db: DatabaseSync,
    channel: {
      name: string;
      endpointType?: string;
      baseUrl: string;
      apiKey?: string;
      extraHeaders?: string;
    },
  ): number {
    const result = db
      .prepare(
        "INSERT INTO channels (name, endpoint_type, base_url, api_key, extra_headers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        channel.name,
        channel.endpointType ?? "openai-chat",
        channel.baseUrl,
        channel.apiKey ?? "",
        channel.extraHeaders ?? "{}",
        OLD,
        OLD,
      );
    return Number(result.lastInsertRowid);
  }

  function channelRow(db: DatabaseSync, id: number) {
    const row = db
      .prepare(
        "SELECT base_url, extra_headers, updated_at FROM channels WHERE id = ?",
      )
      .get(id);
    return {
      baseUrl: String(row?.base_url),
      headers: JSON.parse(String(row?.extra_headers)) as Record<
        string,
        string
      >,
      updatedAt: String(row?.updated_at),
    };
  }

  const basic = (credentials: string) =>
    `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;

  it("基础地址里的用户名密码移到 Authorization: Basic，已有 Authorization 时只去掉；每个渠道打一行不含密钥的提示", () => {
    const db = open();
    const encoded = insertChannel(db, {
      name: "带凭据的中转",
      baseUrl: "http://proxy%20user:p%40ss%3Aword@relay.example.com:4010/v1",
      extraHeaders: JSON.stringify({ "X-Org": "org-1" }),
    });
    const kept = insertChannel(db, {
      name: "已有认证头",
      endpointType: "anthropic",
      baseUrl: "https://u:secret-pw@claude.example.com",
      apiKey: "sk-ant-kept",
      extraHeaders: JSON.stringify({ authorization: "Bearer keep-me" }),
    });
    const bearer = insertChannel(db, {
      name: "OpenAI 带密钥",
      baseUrl: "https://only-token@api.example.com/v1/",
      apiKey: "sk-openai-key",
    });
    const clean = insertChannel(db, {
      name: "正常",
      baseUrl: "https://ok.example.com/v1?tag=a@b",
    });
    db.exec("PRAGMA user_version = 1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    migrate(db);

    expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
    const first = channelRow(db, encoded);
    expect(first.baseUrl).toBe("http://relay.example.com:4010/v1");
    expect(first.headers).toEqual({
      "X-Org": "org-1",
      Authorization: basic("proxy user:p@ss:word"),
    });
    expect(first.updatedAt).not.toBe(OLD);
    // 迁移后的地址能通过现在的校验，开关、改名都不会再被拒
    expect(baseUrlIssue(first.baseUrl)).toBeNull();

    const second = channelRow(db, kept);
    expect(second.baseUrl).toBe("https://claude.example.com");
    expect(second.headers).toEqual({ authorization: "Bearer keep-me" });

    const third = channelRow(db, bearer);
    expect(third.baseUrl).toBe("https://api.example.com/v1/");
    expect(third.headers).toEqual({ Authorization: basic("only-token:") });

    expect(channelRow(db, clean)).toEqual({
      baseUrl: "https://ok.example.com/v1?tag=a@b",
      headers: {},
      updatedAt: OLD,
    });

    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`渠道 #${encoded}「带凭据的中转」`);
    expect(lines[0]).toContain("Authorization: Basic");
    expect(lines[1]).toContain(`渠道 #${kept}「已有认证头」`);
    expect(lines[1]).toContain("已有 Authorization");
    expect(lines[2]).toContain(`渠道 #${bearer}「OpenAI 带密钥」`);
    // OpenAI 类型的密钥也走 Authorization，会被额外请求头顶替，提示里要说
    expect(lines[2]).toContain("顶替");
    expect(lines[0]).not.toContain("顶替");
    for (const line of lines) {
      for (const secret of [
        "proxy",
        "p%40ss",
        "p@ss",
        "secret-pw",
        "only-token",
        "sk-",
        basic("proxy user:p@ss:word").slice(6),
      ]) {
        expect(line).not.toContain(secret);
      }
    }

    // 已经是版本 2 的库再打开不会重复处理
    warn.mockClear();
    migrate(db);
    expect(warn).not.toHaveBeenCalled();
  });

  it("结果报错里地址带的用户名密码打码，其他内容不动", () => {
    const dir = mkdtempSync(join(tmpdir(), "amc-db-"));
    tempDirs.push(dir);
    const file = join(dir, "app.db");
    const legacy = openDatabase(file);
    const channelId = insertChannel(legacy, {
      name: "c",
      baseUrl: "https://ok.example.com/v1",
    });
    legacy
      .prepare(
        "INSERT INTO models (id, channel_id, model, created_at, updated_at) VALUES (1, ?, 'm', ?, ?)",
      )
      .run(channelId, OLD, OLD);
    const promptId = Number(
      legacy.prepare("SELECT id FROM prompts ORDER BY id LIMIT 1").get()?.id,
    );
    const errors: (string | null)[] = [
      "网络错误：Request cannot be constructed from a URL that includes credentials: http://proxyuser:Pr0xyS3cretPass@***:4010/v1/chat/completions",
      "两个地址 https://a:b@x.example 和 ftp://c:d%40e@y.example/p",
      "HTTP 500：请联系 admin@example.com",
      "看这里 https://example.com/a@b",
      null,
    ];
    const insertResult = legacy.prepare(
      "INSERT INTO results (model_id, prompt_id, prompt_snapshot, status, stream, output, error, started_at) VALUES (1, ?, 'p', 'error', 0, ?, ?, ?)",
    );
    for (const error of errors) {
      insertResult.run(promptId, "http://out:put@kept.example", error, OLD);
    }
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();

    const db = open(file);
    expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
    const rows = db
      .prepare("SELECT output, error FROM results ORDER BY id")
      .all();
    expect(rows.map((row) => row.error)).toEqual([
      "网络错误：Request cannot be constructed from a URL that includes credentials: http://***@***:4010/v1/chat/completions",
      "两个地址 https://***@x.example 和 ftp://***@y.example/p",
      "HTTP 500：请联系 admin@example.com",
      "看这里 https://example.com/a@b",
      null,
    ]);
    // 只处理报错，正文不动
    for (const row of rows) {
      expect(row.output).toBe("http://out:put@kept.example");
    }
  });

  it("全新的库直接建到最新版本，不打印迁移提示", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = open();
    expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
    expect(warn).not.toHaveBeenCalled();
  });

  it("maskUrlUserinfo 取到权限部分最后一个 @，重复打码结果不变", () => {
    expect(maskUrlUserinfo("http://u:p@ss@host/x")).toBe("http://***@host/x");
    expect(maskUrlUserinfo("http://***@host/x")).toBe("http://***@host/x");
    expect(maskUrlUserinfo("HTTPS://U:P@H")).toBe("HTTPS://***@H");
    expect(maskUrlUserinfo("http://host/?q=a@b")).toBe("http://host/?q=a@b");
  });
});
