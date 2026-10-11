/**
 * 对外只有两个函数：runCompletion 发一次生成请求，listModels 列出上游模型。
 * 按 endpointType 分派到各家的实现。
 */
import type {
  CompletionRequest,
  CompletionResult,
  ListModelsRequest,
} from "./types.ts";

export * from "./types.ts";

export async function runCompletion(
  request: CompletionRequest,
): Promise<CompletionResult> {
  throw new Error(`not implemented: ${request.endpointType}`);
}

export async function listModels(request: ListModelsRequest): Promise<string[]> {
  throw new Error(`not implemented: ${request.endpointType}`);
}
