import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { TOOLS, callTool } from "./tools.js";

export function createMcpServer(): Server {
  const server = new Server(
    { name: "veriflow", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const payload = await callTool(name, args);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: !payload.ok,
    };
  });

  return server;
}

async function listenHttp(port: number): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "veriflow-mcp", tools: TOOLS.map((t) => t.name) }));
      return;
    }
    await transport.handleRequest(req, res);
  });

  httpServer.listen(port, () => {
    console.log(`veriflow mcp (HTTP) :${port} — tools: ${TOOLS.map((t) => t.name).join(", ")}`);
  });
}

async function main() {
  const stdio = process.argv.includes("--stdio");
  if (stdio) {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }
  const port = Number(process.env.PORT ?? 3333);
  await listenHttp(port);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
