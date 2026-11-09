#!/usr/bin/env node
// Entry point. No arguments: run the MCP server on stdio (what Claude Desktop launches).
// With arguments: the CLI (index build/refresh/enrich/status, cache clear, doc).
const args = process.argv.slice(2);
if (args.length) {
  const { runCli } = await import("./cli.ts");
  process.exitCode = await runCli(args);
} else {
  const { startServer } = await import("./server.ts");
  await startServer();
}
