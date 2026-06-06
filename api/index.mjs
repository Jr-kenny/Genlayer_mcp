export function GET() {
  return Response.json({
    endpoint: "/mcp",
    name: "genskill-mcp",
    status: "ok",
    transport: "streamable-http"
  });
}
