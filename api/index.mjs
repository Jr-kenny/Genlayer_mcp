export function GET() {
  return Response.json({
    endpoint: "/mcp",
    name: "genlayer-docs-mcp",
    status: "ok",
    transport: "streamable-http"
  });
}
