import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  HttpAuthenticationError,
  authenticateHttpTenant
} from "../dist/httpAuth.js";
import { WorkflowSessionStore } from "../dist/genlayerWorkflowSessions.js";
import { createDocsServer } from "../dist/index.js";
import { POST as vercelPost } from "../api/mcp.mjs";

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);
const AUTH_CONFIG = JSON.stringify({
  "tenant-a": TOKEN_A,
  "tenant-b": TOKEN_B
});

test("HTTP tenant authentication requires a configured valid bearer token", () => {
  assert.equal(authenticateHttpTenant(`Bearer ${TOKEN_A}`, AUTH_CONFIG), "tenant-a");
  assert.throws(
    () => authenticateHttpTenant(undefined, AUTH_CONFIG),
    (error) => error instanceof HttpAuthenticationError && error.statusCode === 401
  );
  assert.throws(
    () => authenticateHttpTenant(`Bearer ${"x".repeat(32)}`, AUTH_CONFIG),
    (error) => error instanceof HttpAuthenticationError && error.statusCode === 401
  );
  assert.throws(
    () => authenticateHttpTenant(`Bearer ${TOKEN_A}`, undefined),
    (error) => error instanceof HttpAuthenticationError && error.statusCode === 503
  );
  assert.throws(
    () => authenticateHttpTenant(
      `Bearer ${TOKEN_A}`,
      JSON.stringify({ "tenant-a": TOKEN_A, "tenant-b": TOKEN_A })
    ),
    (error) => error instanceof HttpAuthenticationError && error.statusCode === 503
  );
});

test("Vercel MCP endpoint rejects unauthenticated requests and accepts a configured tenant", async () => {
  const previous = process.env.GENSKILL_MCP_TENANT_TOKENS;
  process.env.GENSKILL_MCP_TENANT_TOKENS = AUTH_CONFIG;
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "security-test", version: "1.0.0" }
    }
  });

  try {
    const unauthenticated = await vercelPost(new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: requestBody
    }));
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /^Bearer /);

    const authenticated = await vercelPost(new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN_A}`,
        "content-type": "application/json"
      },
      body: requestBody
    }));
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).result.serverInfo.name, "genskill-mcp");
  } finally {
    if (previous === undefined) {
      delete process.env.GENSKILL_MCP_TENANT_TOKENS;
    } else {
      process.env.GENSKILL_MCP_TENANT_TOKENS = previous;
    }
  }
});

test("workflow sessions are isolated by authenticated tenant", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "genskill-session-test-"));
  try {
    const tenantA = new WorkflowSessionStore(root, "tenant-a");
    const tenantB = new WorkflowSessionStore(root, "tenant-b");
    const created = await tenantA.create({
      goal: "onboard",
      network: "test",
      phases: []
    });

    assert.equal((await tenantA.list()).length, 1);
    assert.equal((await tenantB.list()).length, 0);
    assert.equal(await tenantB.get(created.id), undefined);
    await assert.rejects(() => tenantA.get("../../shared-secret"), /Invalid workflow session id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP-mode MCP servers do not expose or indirectly allow local file loading", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "genskill-server-test-"));
  const server = createDocsServer({
    allowLocalFileAccess: false,
    workflowSessionStore: new WorkflowSessionStore(root, "tenant-a")
  });
  const client = new Client({ name: "security-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((tool) => tool.name === "genlayer_load_contract_artifact"),
      false
    );

    const result = await client.callTool({
      name: "genlayer_plan_contract_workflow",
      arguments: { contractPath: "/etc/passwd" }
    });
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    assert.match(text, /Local contract paths are disabled for HTTP clients/);
    assert.doesNotMatch(text, /root:/);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
