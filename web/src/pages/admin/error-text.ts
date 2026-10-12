/**
 * 出错信息的文字（纯函数，单独放一个文件：不依赖组件库，测试和 hook 都能直接用）。
 * 各页从 ui.tsx 引入。
 */

/** 把捕获到的错误变成一句可以直接给人看的话 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "操作失败，请稍后重试。";
}
