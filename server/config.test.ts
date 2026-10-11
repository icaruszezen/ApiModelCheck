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
  proxyHops,
  readEnvConfig,
  resolveSessionSecret,
  weakPasswordWarning,
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
      trustProxy: 0,
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
      trustProxy: 1,
      schedulerTickSeconds: 5,
    });
  });

  it("TRUST_PROXY 是信任的代理层数", () => {
    const hops = (value: string | undefined) =>
      readEnvConfig({ TRUST_PROXY: value }).trustProxy;
    for (const off of [undefined, "", "  ", "0", "false", "no", "off", "OFF"])
      expect(hops(off)).toBe(0);
    for (const one of ["1", "true", "yes", "on", " True "])
      expect(hops(one)).toBe(1);
    expect(hops("2")).toBe(2);
    expect(hops("10")).toBe(10);
    for (const bad of ["maybe", "-1", "1.5", "11", "0x2"])
      expect(() => hops(bad)).toThrow(/TRUST_PROXY/);
  });

  it("数字不合法时报错", () => {
    expect(() => readEnvConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => readEnvConfig({ SCHEDULER_TICK_SECONDS: "0" })).toThrow(
      /SCHEDULER_TICK_SECONDS/,
    );
  });
});

describe("proxyHops", () => {
  it("布尔值当作 0 / 1 层，数字原样", () => {
    expect(proxyHops(false)).toBe(0);
    expect(proxyHops(true)).toBe(1);
    expect(proxyHops(0)).toBe(0);
    expect(proxyHops(3)).toBe(3);
  });
});

describe("weakPasswordWarning", () => {
  it("没设、或足够长时不提醒", () => {
    expect(weakPasswordWarning(null)).toBeNull();
    expect(weakPasswordWarning("abcdefgh")).toBeNull();
    expect(weakPasswordWarning("一二三四五六七八")).toBeNull();
  });

  it("示例密码或少于 8 个字符时提醒", () => {
    expect(weakPasswordWarning("change-me")).toMatch(/change-me/);
    expect(weakPasswordWarning("abc1234")).toMatch(/7 个字符/);
    expect(weakPasswordWarning("一二三")).toMatch(/3 个字符/);
  });

  it("文档里的占位密码和常见弱密码不分大小写都提醒，包括带引号、首尾空白的写法", () => {
    for (const password of [
      "change-me",
      "Change-Me",
      "CHANGEME",
      "Password",
      "ADMIN",
      "123456",
      "12345678",
      "你自己的密码",
      "换成你自己的密码",
      "你的密码",
      "'换成你自己的密码'",
      '"change-me"',
      "  password  ",
    ]) {
      expect(weakPasswordWarning(password), password).toMatch(/占位密码/);
    }
    // 只是包含这些词的长密码不算
    expect(weakPasswordWarning("change-me-to-something-else")).toBeNull();
    expect(weakPasswordWarning("换成你自己的密码吧2026")).toBeNull();
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
