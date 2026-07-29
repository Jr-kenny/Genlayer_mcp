import docsModule from "../dist/index.js";
import sessionModule from "../dist/genlayerWorkflowSessions.js";
import authModule from "../dist/httpAuth.js";
import os from "node:os";
import path from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const { createDocsServer } = docsModule;
const { WorkflowSessionStore } = sessionModule;
const {
  HttpAuthenticationError,
  resolveOptionalHttpTenant,
  readTenantTokenConfiguration
} = authModule;

const corsHeaders = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version",
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
  try {
    const tenantId = resolveOptionalHttpTenant(
      request.headers.get("authorization") ?? undefined,
      readTenantTokenConfiguration()
    );
    const sessionRoot = process.env.GENSKILL_MCP_SESSION_DIR
      ?? path.join(os.tmpdir(), "genskill-mcp-workflow-sessions");
    const server = createDocsServer({
      allowLocalFileAccess: false,
      enableWorkflowSessions: Boolean(tenantId),
      ...(tenantId
        ? { workflowSessionStore: new WorkflowSessionStore(sessionRoot, tenantId) }
        : {})
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    return withCors(response);
  } catch (error) {
    if (error instanceof HttpAuthenticationError) {
      const response = jsonResponse(
        {
          jsonrpc: "2.0",
          error: {
            code: error.statusCode === 401 ? -32001 : -32002,
            message: error.message
          },
          id: null
        },
        error.statusCode
      );
      if (error.statusCode === 401) {
        response.headers.set("WWW-Authenticate", 'Bearer realm="genskill-mcp"');
      }
      return response;
    }
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
