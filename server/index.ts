/**
 * 服务入口：读配置 → 打开数据库 → 修复残留的 running 记录 → 启动调度器 → 监听端口。
 * 收到 SIGINT / SIGTERM 时停调度、中止进行中的检测、关 HTTP 服务后退出。
 */
import type { Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import {
  generatePassword,
  PROJECT_ROOT,
  readEnvConfig,
  resolveSessionSecret,
  weakPasswordWarning,
} from "./config.ts";
import { openDatabase } from "./db.ts";
import { Repo } from "./repo.ts";
import { createScheduler, RESTART_MESSAGE } from "./scheduler.ts";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  const env = readEnvConfig();
  // 数据目录里有明文的 API 密钥和会话密钥：之后新建的目录和文件（含 SQLite 的 -wal / -shm）只给自己读写
  process.umask(0o077);
  mkdirSync(env.dataDir, { recursive: true, mode: 0o700 });

  const adminPassword = env.adminPassword ?? generatePassword();
  const sessionSecret = resolveSessionSecret(env.dataDir, env.sessionSecret);

  const db = openDatabase(join(env.dataDir, "app.db"));
  const repo = new Repo(db);
  const recovered = repo.recoverStaleRunning(RESTART_MESSAGE);
  if (recovered > 0) {
    console.log(`[server] ${recovered} 条上次没跑完的检测已标记为中断`);
  }

  const scheduler = createScheduler({
    repo,
    tickMs: env.schedulerTickSeconds * 1000,
  });

  const app = createApp({
    repo,
    scheduler,
    config: {
      adminUsername: env.adminUsername,
      adminPassword,
      sessionSecret,
      trustProxy: env.trustProxy,
    },
    staticDir: join(PROJECT_ROOT, "dist", "web"),
  });

  const server = serve(
    { fetch: app.fetch, port: env.port, hostname: env.host },
    (info) => {
      const shownHost =
        info.address === "0.0.0.0" || info.address === "::"
          ? "localhost"
          : info.address;
      console.log(
        `[server] 已启动：http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${info.port}`,
      );
      console.log(`[server] 数据目录：${env.dataDir}`);
      scheduler.start();
    },
  ) as Server;

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `[server] 端口 ${env.port} 已被占用，请换一个 PORT`
        : "[server] HTTP 服务出错",
      err.code === "EADDRINUSE" ? "" : err,
    );
    void shutdown(1);
  });

  const weak = weakPasswordWarning(env.adminPassword);
  if (weak) {
    const line = "!".repeat(64);
    console.warn(["", line, `  [警告] ${weak}`, line, ""].join("\n"));
  }

  if (!env.adminPassword) {
    const line = "=".repeat(64);
    console.warn(
      [
        "",
        line,
        "  没有设置 ADMIN_PASSWORD，本次启动生成了临时的后台密码：",
        "",
        `    用户名：${env.adminUsername}`,
        `    密  码：${adminPassword}`,
        "",
        "  每次重启都会换一个。请设置环境变量 ADMIN_PASSWORD 来固定密码。",
        line,
        "",
      ].join("\n"),
    );
  }

  let shuttingDown = false;
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[server] 正在停止…");
    // 有请求卡住时也要能退出
    setTimeout(() => {
      console.error("[server] 停止超时，强制退出");
      process.exit(code || 1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await scheduler.stop();
    } catch (err) {
      console.error("[server] 停止调度器时出错", err);
    }
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      // 空闲的 keep-alive 连接不会自己断开，主动关掉
      server.closeIdleConnections?.();
    });
    try {
      db.close();
    } catch {
      // 已经关过
    }
    process.exit(code);
  }

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
}

try {
  main();
} catch (err) {
  console.error(
    "[server] 启动失败：",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
