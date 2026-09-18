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

/**
 * One StreamableHTTP transport + server instance per MCP session.
 * Sharing a single transport across HTTP clients breaks concurrent sessions.
 */
async function listenHttp(port: number): Promise<void> {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "veriflow-mcp", tools: TOOLS.map((t) => t.name) }));
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const existingId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

    if (existingId) {
      const session = sessions.get(existingId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    // New session (initialize request): stand up a dedicated transport.
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    await server.connect(transport);
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
