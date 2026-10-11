import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generatePassword,
  PROJECT_ROOT,
  readEnvConfig,
  resolveSessionSecret,
} from "./config.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "amc-config-"));
  dirs.push(dir);
  return dir;
}

describe("readEnvConfig", () => {
  it("缺省值", () => {
    expect(readEnvConfig({})).toEqual({
      port: 3000,
      host: "0.0.0.0",
      dataDir: join(PROJECT_ROOT, "data"),
      adminUsername: "admin",
      adminPassword: null,
      sessionSecret: null,
      trustProxy: false,
      schedulerTickSeconds: 15,
    });
  });

  it("读取环境变量", () => {
    const config = readEnvConfig({
      PORT: "8080",
      HOST: "127.0.0.1",
      DATA_DIR: "some/dir",
      ADMIN_USERNAME: "boss",
      ADMIN_PASSWORD: " p w ",
      SESSION_SECRET: "secret",
      TRUST_PROXY: "true",
      SCHEDULER_TICK_SECONDS: "5",
    });
    expect(config).toEqual({
      port: 8080,
      host: "127.0.0.1",
      dataDir: resolve("some/dir"),
      adminUsername: "boss",
      adminPassword: " p w ",
      sessionSecret: "secret",
      trustProxy: true,
      schedulerTickSeconds: 5,
    });
    expect(readEnvConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
    expect(readEnvConfig({ TRUST_PROXY: "0" }).trustProxy).toBe(false);
  });

  it("数字不合法时报错", () => {
    expect(() => readEnvConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => readEnvConfig({ SCHEDULER_TICK_SECONDS: "0" })).toThrow(
      /SCHEDULER_TICK_SECONDS/,
    );
  });
});

describe("generatePassword", () => {
  it("16 位、不含易混淆字符、每次不同", () => {
    const a = generatePassword();
    expect(a).toHaveLength(16);
    expect(a).not.toMatch(/[0O1lI]/);
    expect(generatePassword()).not.toBe(a);
  });
});

describe("resolveSessionSecret", () => {
  it("优先用环境变量", () => {
    const dir = tempDir();
    expect(resolveSessionSecret(dir, "from-env")).toBe("from-env");
  });

  it("没有时生成并以 0600 保存，之后复用", () => {
    const dir = tempDir();
    const first = resolveSessionSecret(dir, null);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const file = join(dir, "session-secret");
    expect(readFileSync(file, "utf8").trim()).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveSessionSecret(dir, null)).toBe(first);
  });

  it("文件内容太短时重新生成", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "session-secret"), "short", { mode: 0o644 });
    const secret = resolveSessionSecret(dir, null);
    expect(secret).toHaveLength(64);
    expect(statSync(join(dir, "session-secret")).mode & 0o777).toBe(0o600);
  });
});
