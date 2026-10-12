import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "web/src/**/*.test.ts",
    ],
    environment: "node",
    // node:sqlite 还标着实验性，每个测试进程都会打一遍提示
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
