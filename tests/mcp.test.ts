import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { buildSnapshot, decideApproval, getRunRow, listEvents, startRun } from "@/lib/server/agents/runner";
import { createAgent, createMcpServer, getMcpRow, listMcpServers, updateMcpServer } from "@/lib/server/agents/store";
import { connectMcp, describeTools } from "@/lib/server/tools/mcp";
import { agentConfigSchema } from "@/lib/shared/agents";
import { MockOpenRouter } from "./helpers/mock-openrouter";
import { textReply, toolReply } from "./helpers/responses";

const accountId = "acct_mcp";
const mock = new MockOpenRouter();
const seenAuth: (string | undefined)[] = [];
let mcpUrl = "";

// A real MCP server (official SDK, Streamable HTTP, stateless) with one tool.
const mcpHttp = http.createServer(async (req, res) => {
  seenAuth.push(req.headers.authorization);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const server = new McpServer({ name: "test-mcp", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
});

beforeAll(async () => {
  process.env.OPENROUTER_BASE_URL = await mock.start();
  await new Promise<void>((resolve) => mcpHttp.listen(0, "127.0.0.1", resolve));
  mcpUrl = `http://127.0.0.1:${(mcpHttp.address() as AddressInfo).port}/mcp`;
  getDb().insert(schema.accounts).values({ id: accountId, keyHash: "h-mcp", keyEnc: "x", keyHint: "x", source: "paste" }).run();
});
afterAll(async () => {
  await mock.stop();
  mcpHttp.closeAllConnections();
  await new Promise((resolve) => mcpHttp.close(resolve));
});
beforeEach(() => mock.reset());

async function finished(runId: string, want = ["completed", "failed", "cancelled"]) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = getRunRow(accountId, runId);
    if (want.includes(row.status)) return row;
    if (Date.now() > deadline) throw new Error(`stuck in ${row.status}: ${JSON.stringify(listEvents(runId))}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("MCP servers", () => {
  it("connects, lists tools, and sends the stored bearer token", async () => {
    const server = createMcpServer(accountId, { name: "local", url: mcpUrl, authKind: "bearer", token: "s3cret-token", requireApproval: false, enabled: true });
    const conn = await connectMcp(getMcpRow(accountId, server.id));
    expect(describeTools(conn.tools)).toEqual([{ name: "echo", description: "Echo text back" }]);
    await conn.close();
    expect(seenAuth).toContain("Bearer s3cret-token");
  });

  it("never returns stored credentials, and keeps them when an update omits them", () => {
    const [server] = listMcpServers(accountId);
    expect(server).toMatchObject({ hasCredentials: true, authKind: "bearer" });
    expect(JSON.stringify(server)).not.toContain("s3cret-token");
    const stored = getMcpRow(accountId, server.id).authEnc!;
    expect(stored).not.toContain("s3cret-token"); // sealed at rest

    updateMcpServer(accountId, server.id, { name: "local", url: mcpUrl, authKind: "bearer", requireApproval: false, enabled: true });
    expect(getMcpRow(accountId, server.id).authEnc).toBe(stored);
    // Switching the auth scheme without a new secret must drop the old one.
    updateMcpServer(accountId, server.id, { name: "local", url: mcpUrl, authKind: "headers", requireApproval: false, enabled: true });
    expect(getMcpRow(accountId, server.id).authEnc).toBeNull();
    updateMcpServer(accountId, server.id, { name: "local", url: mcpUrl, authKind: "none", requireApproval: false, enabled: true });
  });

  it("lets an agent call an MCP tool through the guard", async () => {
    const [server] = listMcpServers(accountId);
    const agent = createAgent(accountId, { name: "mcp-user", description: "", config: agentConfigSchema.parse({ model: "test/model", tools: [`mcp:${server.id}`] }) });
    mock.on("/responses", toolReply([{ name: "echo", args: { text: "hello" } }]), textReply("It said hello."));
    const runId = startRun({ accountId, apiKey: "sk-test", snapshot: buildSnapshot(accountId, agent.id), input: "go", agentId: agent.id });
    expect(await finished(runId)).toMatchObject({ status: "completed", output: "It said hello." });

    const events = listEvents(runId);
    expect(events.find((e) => e.type === "tool.call")).toMatchObject({ name: "echo", source: "mcp" });
    const result = events.find((e) => e.type === "tool.result");
    expect(result).toMatchObject({ name: "echo", status: "ok" });
    expect(JSON.stringify(result)).toContain("echo: hello");
    // The tool list sent to the model includes the MCP tool with its schema.
    const tools = (mock.calls("/responses")[0].body as { tools: { name: string; parameters: { properties: object } }[] }).tools;
    expect(tools.find((t) => t.name === "echo")?.parameters.properties).toHaveProperty("text");
    expect(getDb().select().from(schema.toolCalls).all().filter((c) => c.runId === runId)).toMatchObject([{ toolName: "echo", source: "mcp", status: "ok" }]);
  });

  it("holds MCP tool calls for approval when the agent requires it", async () => {
    const [server] = listMcpServers(accountId);
    const ref = `mcp:${server.id}`;
    const agent = createAgent(accountId, { name: "mcp-gated", description: "", config: agentConfigSchema.parse({ model: "test/model", tools: [ref], requireApproval: [ref] }) });
    mock.on("/responses", toolReply([{ name: "echo", args: { text: "careful" }, id: "call_mcp1" }]), textReply("Done."));
    const runId = startRun({ accountId, apiKey: "sk-test", snapshot: buildSnapshot(accountId, agent.id), input: "go", agentId: agent.id });
    await finished(runId, ["awaiting_approval"]);
    expect(listEvents(runId).some((e) => e.type === "tool.result")).toBe(false);
    decideApproval(accountId, "sk-test", runId, { approve: ["call_mcp1"], reject: [] });
    expect(await finished(runId)).toMatchObject({ status: "completed" });
    expect(JSON.stringify(listEvents(runId).find((e) => e.type === "tool.result"))).toContain("echo: careful");
  });

  it("degrades to a warning when a server is unreachable", async () => {
    const dead = createMcpServer(accountId, { name: "dead", url: "http://127.0.0.1:1/mcp", authKind: "none", requireApproval: false, enabled: true });
    const agent = createAgent(accountId, { name: "mcp-dead", description: "", config: agentConfigSchema.parse({ model: "test/model", tools: [`mcp:${dead.id}`] }) });
    mock.on("/responses", textReply("No tools, but I am fine."));
    const runId = startRun({ accountId, apiKey: "sk-test", snapshot: buildSnapshot(accountId, agent.id), input: "go", agentId: agent.id });
    expect(await finished(runId)).toMatchObject({ status: "completed" });
    const notice = listEvents(runId).find((e) => e.type === "notice");
    expect(notice && "message" in notice ? notice.message : "").toMatch(/Could not connect to MCP server "dead"/);
  });
});
