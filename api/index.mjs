export function GET() {
  return Response.json({
    endpoint: "/mcp",
    name: "genlayer-mcp",
    status: "ok",
    transport: "streamable-http"
  });
}
