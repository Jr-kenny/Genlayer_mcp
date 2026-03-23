#!/usr/bin/env node
import http, { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDocsServer } from "./index.js";

const DEFAULT_PORT = 3000;
const port = readPort(process.env.PORT) ?? DEFAULT_PORT;

export async function startHttpServer(): Promise<void> {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        writeText(res, 400, "Missing request URL.");
        return;
      }

      const requestUrl = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      if (requestUrl.pathname === "/") {
        writeJson(res, 200, {
          name: "genlayer-docs-mcp",
          transport: "streamable-http",
          endpoint: "/mcp",
          status: "ok"
        });
        return;
      }

      if (requestUrl.pathname === "/health") {
        writeJson(res, 200, { status: "ok" });
        return;
      }

      if (requestUrl.pathname !== "/mcp") {
        writeText(res, 404, "Not found.");
        return;
      }

      if (!isSupportedMethod(req.method)) {
        res.setHeader("Allow", "GET, POST, DELETE");
        writeText(res, 405, "Method not allowed.");
        return;
      }

      const parsedBody = shouldParseBody(req.method) ? await readJsonBody(req, res) : undefined;
      if (res.writableEnded) {
        return;
      }

      const mcpServer = createDocsServer();
      const transport = new StreamableHTTPServerTransport();

      await mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);
      await transport.handleRequest(req, res, parsedBody);

      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: `Internal server error: ${message}`
          },
          id: null
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => resolve());
    server.once("error", reject);
  });

  console.error(`GenLayer docs MCP HTTP server listening on port ${port}`);

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function shouldParseBody(method: string | undefined): boolean {
  return method === "POST";
}

function isSupportedMethod(method: string | undefined): boolean {
  return method === "GET" || method === "POST" || method === "DELETE";
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Invalid JSON request body."
      },
      id: null
    });
    return undefined;
  }
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function readPort(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

startHttpServer().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
