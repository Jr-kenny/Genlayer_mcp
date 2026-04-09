import docsModule from "../dist/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const { createDocsServer } = docsModule;

const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version"
};

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}

export async function GET(request) {
  return handleMcpRequest(request);
}

export async function POST(request) {
  return handleMcpRequest(request);
}

export async function DELETE(request) {
  return handleMcpRequest(request);
}

async function handleMcpRequest(request) {
  const server = createDocsServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    return withCors(response);
  } catch (error) {
    console.error("MCP request failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: `Internal server error: ${message}`
        },
        id: null
      },
      500
    );
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}
