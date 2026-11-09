import { buildStatus, renderStatus } from "../status.ts";
import { errorResult, text, type ToolContext } from "./context.ts";

export const STATUS_DESCRIPTION =
  "Report what this documentation server covers and how fresh it is: sources, search mode, last index build/refresh, number of indexed pages, frameworks and platforms represented, cache health, known coverage gaps and recent errors.";

export function statusTool(ctx: ToolContext) {
  try {
    const store = ctx.index();
    const err = ctx.indexError();
    return text(renderStatus(buildStatus({ store, ...(store ? {} : err ? { storeError: err } : {}), cache: ctx.cache, recentErrors: ctx.recentErrors })));
  } catch (e) {
    return errorResult(ctx, "get_apple_docs_status", e);
  }
}
