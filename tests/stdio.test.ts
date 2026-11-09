// End-to-end: launch the real entry point as a child process over stdio, like Claude Desktop does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const entry = new URL("../src/index.ts", import.meta.url).pathname;
let dir: string;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("stdio server process", () => {
  it("starts, lists tools, answers status, and keeps stdout protocol-only", async () => {
    dir = mkdtempSync(join(tmpdir(), "sdm-stdio-"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, SWIFT_DOCS_MCP_HOME: dir } as Record<string, string>, stderr: "pipe" });
    const protocolErrors: Error[] = [];
    transport.onerror = (e) => protocolErrors.push(e);
    let stderr = "";
    transport.stderr?.on("data", (d) => (stderr += d));
    client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_apple_api_details", "get_apple_doc", "get_apple_docs_status", "search_apple_docs"]);
    const r: any = await client.callTool({ name: "get_apple_docs_status", arguments: {} });
    expect(r.content[0].text).toContain("Index: not available");
    const bad: any = await client.callTool({ name: "get_apple_doc", arguments: { url: "https://example.com/x" } });
    expect(bad.isError).toBe(true);

    expect(protocolErrors).toEqual([]); // any non-JSON line on stdout would surface here
    expect(stderr).toContain("swift-docs-mcp 0.1.0 ready");
  }, 30_000);
});
