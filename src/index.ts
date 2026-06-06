import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  GenlayerDocsService,
  buildIndexDocument,
  buildResourceList,
  formatRelatedDocs,
  formatSearchResults,
  formatSection,
  formatTopics
} from "./genlayerDocs.js";
import {
  GenlayerRpcService,
  buildNetworkPresetsDocument,
  buildRpcConfigDocument,
  formatJson,
  interpretTransactionStatus,
  listNetworkPresets
} from "./genlayerRpc.js";
import {
  buildContractPlaybook,
  buildExecutionPlan,
  buildWorkflowPlan,
  buildTypeScriptInteractionGuide,
  formatExecutionPlan,
  formatContractInterface,
  formatWorkflowPlan,
  normalizeContractSchema
} from "./genlayerContractToolkit.js";
import { loadContractArtifact } from "./genlayerArtifacts.js";
import {
  WorkflowSessionStore,
  formatWorkflowSession,
  workflowPlanToSessionPhases
} from "./genlayerWorkflowSessions.js";
import { registerAuthoring } from "./authoringTools.js";
import { isCanonicalEnvelope, makeCanonicalResponse, textEnvelope } from "./mcpResponses.js";

const service = new GenlayerDocsService();
const rpcService = new GenlayerRpcService();
const workflowSessions = new WorkflowSessionStore();

export function createDocsServer(): McpServer {
  const server = new McpServer(
    {
      name: "genlayer-docs-mcp",
      version: "2.2.2",
      websiteUrl: "https://docs.genlayer.com/",
      description: "MCP server for GenLayer documentation, protocol inspection, and transaction workflows."
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );
  registerDocsToolsAndResources(server);
  return server;
}


function registerDocsToolsAndResources(server: McpServer): void {
  registerAuthoring(server);
  server.registerTool(
    "genlayer_start_workflow_session",
    {
      title: "Start Workflow Session",
      description: "Create a persisted GenLayer workflow session from a generated contract workflow plan.",
      inputSchema: {
        address: z.string().optional().describe("Deployed contract address to target."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly."),
        contractPath: z.string().optional().describe("Optional local contract artifact path for deploy workflows."),
        goal: z.enum(["deploy", "read", "write", "debug", "onboard"]).default("onboard").describe("Primary workflow goal."),
        notes: z.string().optional().describe("Optional operator notes to store with the session.")
      },
      annotations: {
        title: "Start Workflow Session",
        readOnlyHint: false,
        idempotentHint: false
      }
    },
    async ({ address, code, contractPath, goal, notes }) => {
      const schema = await resolveContractSchemaFromAnySource(address, code, contractPath).catch((error) => {
        return unsupportedContractRpcEnvelope("workflow_session_start", error);
      });
      if (isCanonicalEnvelope(schema)) {
        return textEnvelope(schema);
      }
      const summary = normalizeContractSchema(schema);
      const preset = inferCurrentNetworkPreset();
      const workflow = buildWorkflowPlan({
        chainLabel: preset?.label ?? "custom",
        schema: summary,
        ...(address ? { address } : {}),
        ...(contractPath ? { contractPath } : {})
      });

      const session = await workflowSessions.create({
        goal,
        network: preset?.label ?? "custom",
        phases: workflowPlanToSessionPhases(workflow),
        ...(address ? { address } : {}),
        ...(contractPath ? { contractPath } : {}),
        ...(notes ? { notes } : {})
      });

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "workflow_session",
                summary: `Started workflow session ${session.id}.`,
                currentState: sessionStateSnapshot(session),
                blockers: [],
                nextActions: workflowSessionNextActions(session),
                fallbacks: ["If endpoint capabilities are limited, continue with the remaining non-blocked session steps."],
                data: { session }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_list_workflow_sessions",
    {
      title: "List Workflow Sessions",
      description: "List persisted GenLayer workflow sessions ordered by most recently updated.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of sessions to list.")
      },
      annotations: {
        title: "List Workflow Sessions",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ limit }) => {
      const sessions = await workflowSessions.list(limit);
      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "workflow_session_list",
                summary: `Loaded ${sessions.length} workflow sessions.`,
                currentState: { sessionCount: sessions.length },
                blockers: [],
                nextActions: sessions.length === 0
                  ? ["Start a workflow session with `genlayer_start_workflow_session`."]
                  : ["Read a specific session with `genlayer_get_workflow_session`."],
                fallbacks: [],
                data: {
                  sessions: sessions.map((session) => ({
                    id: session.id,
                    goal: session.goal,
                    network: session.network,
                    progress: `${session.completedSteps}/${session.totalSteps}`,
                    updatedAt: session.updatedAt,
                    ...(session.address ? { address: session.address } : {})
                  }))
                }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_workflow_session",
    {
      title: "Get Workflow Session",
      description: "Read a persisted GenLayer workflow session by id.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Workflow session id.")
      },
      annotations: {
        title: "Get Workflow Session",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ sessionId }) => {
      const session = await workflowSessions.get(sessionId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown workflow session "${sessionId}".`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "workflow_session",
                summary: `Loaded workflow session ${session.id}.`,
                currentState: sessionStateSnapshot(session),
                blockers: [],
                nextActions: workflowSessionNextActions(session),
                fallbacks: [],
                data: { session }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_update_workflow_step",
    {
      title: "Update Workflow Step",
      description: "Mark a specific workflow session step as completed or pending.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Workflow session id."),
        phaseIndex: z.number().int().min(0).describe("Zero-based phase index."),
        stepIndex: z.number().int().min(0).describe("Zero-based step index within the phase."),
        completed: z.boolean().default(true).describe("Whether the step should be marked completed.")
      },
      annotations: {
        title: "Update Workflow Step",
        readOnlyHint: false,
        idempotentHint: true
      }
    },
    async ({ sessionId, phaseIndex, stepIndex, completed }) => {
      const session = await workflowSessions.updateStep({
        id: sessionId,
        phaseIndex,
        stepIndex,
        completed
      });

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "workflow_session",
                summary: `Updated workflow session ${session.id}.`,
                currentState: sessionStateSnapshot(session),
                blockers: [],
                nextActions: workflowSessionNextActions(session),
                fallbacks: [],
                data: { session }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_autopilot_brief",
    {
      title: "Generate GenLayer Autopilot Brief",
      description: "Generate a single high-context operator brief that combines endpoint capabilities, contract context, workflow plans, weak-agent handoff steps, and relevant docs.",
      inputSchema: {
        address: z.string().optional().describe("Deployed contract address to target."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly."),
        contractPath: z.string().optional().describe("Optional local contract artifact path for onboarding or deploy workflows."),
        goal: z.enum(["deploy", "read", "write", "debug", "onboard"]).default("onboard").describe("Primary goal for the operator brief.")
      },
      annotations: {
        title: "Generate GenLayer Autopilot Brief",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, code, contractPath, goal }) => {
      const brief = await buildAutopilotBrief({
        goal,
        ...(address ? { address } : {}),
        ...(code ? { code } : {}),
        ...(contractPath ? { contractPath } : {})
      });
      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "autopilot_brief",
                summary: `Generated autopilot brief for goal "${goal}".`,
                currentState: {
                  goal,
                  endpoint: brief.capabilities.endpoint,
                  hasAddress: Boolean(address),
                  hasContractPath: Boolean(contractPath)
                },
                blockers: extractCapabilityBlockers(brief.capabilities),
                nextActions: brief.orderedNextActions,
                fallbacks: [
                  "If a recommended capability is not exposed, use the fallback rules in the handoff and continue with report tools."
                ],
                data: brief
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_load_contract_artifact",
    {
      title: "Load Contract Artifact",
      description: "Load a local contract artifact or bytecode file and return base64 plus file metadata for downstream GenLayer workflows.",
      inputSchema: {
        contractPath: z.string().min(1).describe("Local path to a compiled contract artifact or binary/code file.")
      },
      annotations: {
        title: "Load Contract Artifact",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ contractPath }) => {
      const artifact = await loadContractArtifact(contractPath);
      return {
        content: [
          {
            type: "text",
            text: formatJson(artifact)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_probe_endpoint_capabilities",
    {
      title: "Probe Endpoint Capabilities",
      description: "Probe the configured GenLayer deployment and report which health, RPC, sync, and debug surfaces are actually exposed.",
      inputSchema: {},
      annotations: {
        title: "Probe Endpoint Capabilities",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async () => {
      const result = await buildEndpointCapabilityReport();
      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "endpoint_capabilities",
                summary: "Probed endpoint capabilities.",
                currentState: {
                  endpoint: result.endpoint
                },
                blockers: extractCapabilityBlockers(result),
                nextActions: capabilityDrivenNextActions(result),
                fallbacks: ["Missing metrics, balance, or debug endpoints are non-fatal unless the current workflow explicitly depends on them."],
                data: result
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_generate_agent_handoff",
    {
      title: "Generate Agent Handoff",
      description: "Generate an explicit step-by-step GenLayer handoff bundle for weaker agents, including ordered tool usage, fallback paths, and success conditions.",
      inputSchema: {
        address: z.string().optional().describe("Deployed contract address to target."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly."),
        contractPath: z.string().optional().describe("Optional local contract artifact path for onboarding or deploy workflows."),
        goal: z.enum(["deploy", "read", "write", "debug", "onboard"]).default("onboard").describe("Primary agent goal.")
      },
      annotations: {
        title: "Generate Agent Handoff",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, code, contractPath, goal }) => {
      const schema = await resolveContractSchemaFromAnySource(address, code, contractPath).catch((error) => {
        return unsupportedContractRpcEnvelope("agent_handoff", error);
      });
      if (isCanonicalEnvelope(schema)) {
        return textEnvelope(schema);
      }
      const summary = normalizeContractSchema(schema);
      const preset = inferCurrentNetworkPreset();
      const handoff = buildAgentHandoff({
        goal,
        network: preset?.label ?? "custom",
        summary,
        ...(address ? { address } : {}),
        ...(contractPath ? { contractPath } : {})
      });

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "agent_handoff",
                summary: `Generated agent handoff for goal "${goal}".`,
                currentState: {
                  goal,
                  network: preset?.label ?? "custom"
                },
                blockers: [],
                nextActions: handoff.split("\n").filter((line) => /^\d+\./.test(line)).map((line) => line.replace(/^\d+\.\s*/, "")),
                fallbacks: [
                  "If any optional endpoint surface is missing, skip it and continue with capability-supported steps."
                ],
                data: {
                  handoff
                }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_plan_contract_workflow",
    {
      title: "Plan Contract Workflow",
      description: "Build a multi-phase GenLayer contract workflow covering deploy, wait, snapshot, first read/write, and diagnosis.",
      inputSchema: {
        address: z.string().optional().describe("Deployed contract address to target."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly."),
        contractPath: z.string().optional().describe("Optional local or repo-relative contract path for deploy workflows.")
      },
      annotations: {
        title: "Plan Contract Workflow",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, code, contractPath }) => {
      const schema = await resolveContractSchemaFromAnySource(address, code, contractPath).catch((error) => {
        return unsupportedContractRpcEnvelope("contract_workflow_plan", error);
      });
      if (isCanonicalEnvelope(schema)) {
        return textEnvelope(schema);
      }
      const summary = normalizeContractSchema(schema);
      const preset = inferCurrentNetworkPreset();
      const plan = buildWorkflowPlan({
        chainLabel: preset?.label ?? "custom",
        schema: summary,
        ...(address ? { address } : {}),
        ...(contractPath ? { contractPath } : {})
      });

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "contract_workflow_plan",
                summary: "Built contract workflow plan.",
                currentState: {
                  phaseCount: plan.phases.length,
                  recommendedReadMethod: plan.recommendedReadMethod,
                  recommendedWriteMethod: plan.recommendedWriteMethod
                },
                blockers: [],
                nextActions: flattenWorkflowPlanActions(plan),
                fallbacks: ["If deployment is already complete, begin from inspection or interaction phases."],
                data: { plan }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_plan_contract_action",
    {
      title: "Plan Contract Action",
      description: "Build a schema-validated execution plan for deploy, read, or write contract actions.",
      inputSchema: {
        action: z.enum(["deploy", "read", "write"]).describe("Contract action to plan."),
        address: z.string().optional().describe("Deployed contract address for read/write actions."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly."),
        contractPath: z.string().optional().describe("Optional local or repo-relative contract path for deploy workflows."),
        methodName: z.string().optional().describe("Contract method name for read/write actions."),
        args: z.array(z.unknown()).default([]).describe("Positional arguments to validate against the schema."),
        from: z.string().optional().describe("Optional caller address for execution planning."),
        value: z.string().optional().describe("Optional hex or decimal value to send for payable writes."),
        statusTarget: z.enum(["accepted", "finalized"]).default("finalized").describe("Desired terminal status for transaction flows.")
      },
      annotations: {
        title: "Plan Contract Action",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ action, address, code, contractPath, methodName, args, from, value, statusTarget }) => {
      const schema = await resolveContractSchemaFromAnySource(address, code, contractPath).catch((error) => {
        return unsupportedContractRpcEnvelope("contract_action_plan", error);
      });
      if (isCanonicalEnvelope(schema)) {
        return textEnvelope(schema);
      }
      const summary = normalizeContractSchema(schema);
      const preset = inferCurrentNetworkPreset();
      const plan = buildExecutionPlan({
        action,
        args,
        chainLabel: preset?.label ?? "custom",
        schema: summary,
        ...(address ? { address } : {}),
        ...(contractPath ? { contractPath } : {}),
        ...(methodName ? { methodName } : {}),
        ...(from ? { from } : {}),
        ...(value ? { value } : {}),
        ...(action !== "read" ? { statusTarget } : {})
      });

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "contract_action_plan",
                summary: `Built ${action} plan${methodName ? ` for ${methodName}` : ""}.`,
                currentState: {
                  action,
                  validationOk: plan.validation.ok,
                  methodName: plan.methodName ?? null
                },
                blockers: plan.validation.problems,
                nextActions: plan.validation.ok
                  ? [action === "write" ? "Execute the write and then run `genlayer_run_transaction_report`." : "Execute the planned action using the SDK workflow or your client."]
                  : ["Fix validation problems before executing this plan."],
                fallbacks: ["If a method is unclear, regenerate the interface with `genlayer_get_contract_interface`."],
                data: { plan }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_contract_interface",
    {
      title: "Get GenLayer Contract Interface",
      description: "Normalize a contract schema into constructor, view methods, and write methods.",
      inputSchema: {
        address: z.string().optional().describe("Deployed contract address to inspect."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly.")
      },
      annotations: {
        title: "Get GenLayer Contract Interface",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, code }) => {
      const schema = await resolveContractSchemaFromAnySource(address, code).catch((error) => {
        return unsupportedContractRpcEnvelope("contract_interface", error);
      });
      if (isCanonicalEnvelope(schema)) {
        return textEnvelope(schema);
      }
      const summary = normalizeContractSchema(schema);
      return {
        content: [
          {
            type: "text",
            text: formatContractInterface(summary)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_generate_typescript_workflow",
    {
      title: "Generate GenLayer TypeScript Workflow",
      description: "Generate GenLayerJS deploy/read/write code from a contract schema or deployed contract.",
      inputSchema: {
        address: z.string().optional().describe("Deployed contract address to target."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly."),
        contractPath: z.string().optional().describe("Optional local or repo-relative contract path to include in deploy snippets.")
      },
      annotations: {
        title: "Generate GenLayer TypeScript Workflow",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, code, contractPath }) => {
      const schema = await resolveContractSchemaFromAnySource(address, code, contractPath).catch((error) => {
        return unsupportedContractRpcEnvelope("typescript_workflow", error);
      });
      if (isCanonicalEnvelope(schema)) {
        return textEnvelope(schema);
      }
      const summary = normalizeContractSchema(schema);
      const networkPreset = inferCurrentNetworkPreset();
      const snippet = buildTypeScriptInteractionGuide({
        chainImport: presetChainImport(networkPreset?.label),
        chainLabel: presetChainImport(networkPreset?.label),
        schema: summary,
        ...(address ? { address } : {}),
        ...(contractPath ? { contractPath } : {})
      });

      return {
        content: [
          {
            type: "text",
            text: snippet
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_generate_contract_playbook",
    {
      title: "Generate Contract Playbook",
      description: "Generate a schema-aware deployment and interaction playbook for a GenLayer contract.",
      inputSchema: {
        address: z.string().optional().describe("Deployed contract address to target."),
        code: z.string().optional().describe("Base64-encoded contract code to inspect directly."),
        contractPath: z.string().optional().describe("Optional local or repo-relative contract path.")
      },
      annotations: {
        title: "Generate Contract Playbook",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, code, contractPath }) => {
      const schema = await resolveContractSchemaFromAnySource(address, code, contractPath).catch((error) => {
        return unsupportedContractRpcEnvelope("contract_playbook", error);
      });
      if (isCanonicalEnvelope(schema)) {
        return textEnvelope(schema);
      }
      const summary = normalizeContractSchema(schema);
      const preset = inferCurrentNetworkPreset();
      const text = buildContractPlaybook({
        chainLabel: preset?.label ?? "custom",
        schema: summary,
        ...(address ? { address } : {}),
        ...(contractPath ? { contractPath } : {})
      });

      return {
        content: [
          {
            type: "text",
            text
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_list_networks",
    {
      title: "List GenLayer Networks",
      description: "List current GenLayer network presets and RPC endpoints from the documented network matrix.",
      inputSchema: {},
      annotations: {
        title: "List GenLayer Networks",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async () => {
      return {
        content: [
          {
            type: "text",
            text: formatJson(listNetworkPresets())
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_node_health",
    {
      title: "Check GenLayer Node Health",
      description: "Fetch the configured GenLayer node HTTP health endpoint and return the live response.",
      inputSchema: {},
      annotations: {
        title: "Check GenLayer Node Health",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async () => {
      const result = await rpcService.health();
      const snapshot = rpcService.getSnapshot();
      return {
        content: [
          {
            type: "text",
            text: `Endpoint: ${snapshot.endpoint}\n\n${formatJson(result)}`
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_network_status",
    {
      title: "Get GenLayer Network Status",
      description: "Fetch a combined snapshot of GenLayer RPC connectivity, chain id, block height, and syncing status.",
      inputSchema: {},
      annotations: {
        title: "Get GenLayer Network Status",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async () => {
      const snapshot = rpcService.getSnapshot();
      const [health, debugPing, chainId, blockNumber, syncing] = await Promise.all([
        rpcService.health(),
        rpcService.debugPing().catch((error) => ({
          unavailable: true,
          error: error instanceof Error ? error.message : String(error)
        })),
        rpcService.chainId(),
        rpcService.blockNumber(),
        rpcService.syncing().catch((error) => ({
          unavailable: true,
          error: error instanceof Error ? error.message : String(error)
        }))
      ]);

      return {
        content: [
          {
            type: "text",
            text: formatJson({
              endpoint: snapshot.endpoint,
              healthEndpoint: snapshot.healthEndpoint,
              health,
              debugPing,
              chainId,
              blockNumber,
              syncing
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_balance",
    {
      title: "Get GenLayer Balance",
      description: "Fetch the node operator balance from the configured GenLayer HTTP /balance endpoint.",
      inputSchema: {},
      annotations: {
        title: "Get GenLayer Balance",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async () => {
      const result = await rpcService.balance("");
      return {
        content: [
          {
            type: "text",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_metrics",
    {
      title: "Get GenLayer Metrics",
      description: "Fetch Prometheus-style metrics from the configured GenLayer HTTP /metrics endpoint.",
      inputSchema: {},
      annotations: {
        title: "Get GenLayer Metrics",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async () => {
      const result = await rpcService.metrics();
      return {
        content: [
          {
            type: "text",
            text: result
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_eth_get_balance",
    {
      title: "Get EVM Balance Through GenLayer",
      description: "Call eth_getBalance through the configured GenLayer RPC endpoint.",
      inputSchema: {
        address: z.string().min(1).describe("Wallet or contract address to inspect."),
        blockTag: z.string().default("latest").describe("Ethereum block tag, for example latest, pending, or a hex block number.")
      },
      annotations: {
        title: "Get EVM Balance Through GenLayer",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, blockTag }) => {
      const result = await rpcService.getEthBalance(address, blockTag);
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              address,
              blockTag,
              result
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_raw_rpc",
    {
      title: "Call GenLayer RPC Method",
      description: "Call a GenLayer JSON-RPC method directly against the configured endpoint.",
      inputSchema: {
        method: z
          .string()
          .min(1)
          .regex(/^(gen_|eth_|zks_|zksync_)/, "Method must start with gen_, eth_, zks_, or zksync_.")
          .describe("JSON-RPC method name to call."),
        params: z.array(z.unknown()).default([]).describe("Positional JSON-RPC params array.")
      },
      annotations: {
        title: "Call GenLayer RPC Method",
        idempotentHint: true
      }
    },
    async ({ method, params }) => {
      const result = await rpcService.raw(method, params);
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              method,
              params,
              result
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_trace_transaction",
    {
      title: "Trace GenLayer Transaction",
      description: "Call gen_dbg_traceTransaction for a transaction hash when the target node exposes debug methods.",
      inputSchema: {
        txID: z.string().min(1).describe("Transaction hash with 0x prefix."),
        round: z.number().int().min(0).default(0).describe("Optional appeal round to inspect.")
      },
      annotations: {
        title: "Trace GenLayer Transaction",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ txID, round }) => {
      const result = await rpcService.debugTraceTransaction({
        txID,
        round
      });
      return {
        content: [
          {
            type: "text",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_submit_raw_transaction",
    {
      title: "Submit Raw Transaction",
      description: "Submit a signed GenLayer or Ethereum-compatible raw transaction through eth_sendRawTransaction.",
      inputSchema: {
        rawTransaction: z.string().regex(/^0x[0-9a-fA-F]+$/).describe("Signed raw transaction bytes as a 0x-prefixed hex string.")
      },
      annotations: {
        title: "Submit Raw Transaction"
      }
    },
    async ({ rawTransaction }) => {
      const txId = await rpcService.sendRawTransaction(rawTransaction);
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              submitted: true,
              txId
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_inspect_transaction",
    {
      title: "Inspect Transaction",
      description: "Combine GenLayer status, GenLayer receipt, and Ethereum transaction lookup for a transaction hash.",
      inputSchema: {
        txId: z.string().min(1).describe("Transaction hash with 0x prefix."),
        timestamp: z.number().int().positive().optional().describe("Optional unix timestamp override for GenLayer status/receipt methods.")
      },
      annotations: {
        title: "Inspect Transaction",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ txId, timestamp }) => {
      const result = await rpcService.inspectTransaction({
        txId,
        ...(timestamp !== undefined ? { timestamp } : {})
      });
      const statusInfo = interpretTransactionStatus(result.status);
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              ...result,
              statusInfo
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_run_transaction_report",
    {
      title: "Run Transaction Report",
      description: "Orchestrate waiting, inspection, status explanation, optional trace lookup, and optional contract snapshot into one transaction report.",
      inputSchema: {
        txId: z.string().min(1).describe("Transaction hash with 0x prefix."),
        address: z.string().optional().describe("Optional contract address to snapshot alongside the transaction report."),
        timestamp: z.number().int().positive().optional().describe("Optional unix timestamp override for GenLayer status/receipt methods."),
        targetStatus: z.enum(["accepted", "finalized"]).default("finalized").describe("Desired status target if waiting is enabled."),
        intervalMs: z.number().int().min(250).max(60000).default(2500).describe("Polling interval in milliseconds when waiting."),
        maxAttempts: z.number().int().min(1).max(240).default(24).describe("Maximum polling attempts when waiting."),
        wait: z.boolean().default(true).describe("Whether to poll before producing the final report.")
      },
      annotations: {
        title: "Run Transaction Report",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ txId, address, timestamp, targetStatus, intervalMs, maxAttempts, wait }) => {
      const inspection = wait
        ? await rpcService.waitForTransaction({
            txId,
            ...(timestamp !== undefined ? { timestamp } : {}),
            targetStatus,
            intervalMs,
            maxAttempts
          })
        : await rpcService.inspectTransaction({
            txId,
            ...(timestamp !== undefined ? { timestamp } : {})
          });

      const statusInfo = interpretTransactionStatus(inspection.status);
      const trace = await rpcService.debugTraceTransaction({ txID: txId, round: 0 }).catch((error) => ({
        unavailable: true,
        error: error instanceof Error ? error.message : String(error)
      }));
      const contract = address ? await buildContractComposite(address) : undefined;
      const network = await buildNetworkStatusSnapshot();

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "transaction_report",
                summary: `Built transaction report for ${txId}.`,
                currentState: {
                  txId,
                  waited: wait,
                  finalityPhase: statusInfo.finalityPhase,
                  isFinal: statusInfo.isFinal
                },
                blockers: statusInfo.isFinal && !statusInfo.isSuccessfulTerminal
                  ? ["Transaction reached a terminal non-success state."]
                  : [],
                nextActions: transactionReportNextActions(statusInfo, Boolean(address)),
                fallbacks: ["If trace is unavailable, rely on inspect, explain, and receipt outputs."],
                data: {
                  txId,
                  waited: wait,
                  ...(address ? { address } : {}),
                  network,
                  inspection,
                  statusInfo,
                  recommendation: buildStatusRecommendation(statusInfo),
                  trace,
                  ...(contract ? { contract } : {})
                }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_wait_for_transaction",
    {
      title: "Wait For Transaction",
      description: "Poll GenLayer transaction status until accepted or finalized, then return the combined inspection payload.",
      inputSchema: {
        txId: z.string().min(1).describe("Transaction hash with 0x prefix."),
        timestamp: z.number().int().positive().optional().describe("Optional unix timestamp override for GenLayer status/receipt methods."),
        targetStatus: z.enum(["accepted", "finalized"]).default("finalized").describe("Stop polling when this status is reached."),
        intervalMs: z.number().int().min(250).max(60000).default(2500).describe("Polling interval in milliseconds."),
        maxAttempts: z.number().int().min(1).max(240).default(24).describe("Maximum number of polling attempts.")
      },
      annotations: {
        title: "Wait For Transaction"
      }
    },
    async ({ txId, timestamp, targetStatus, intervalMs, maxAttempts }) => {
      const result = await rpcService.waitForTransaction({
        txId,
        ...(timestamp !== undefined ? { timestamp } : {}),
        targetStatus,
        intervalMs,
        maxAttempts
      });
      const statusInfo = interpretTransactionStatus(result.status);
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              ...result,
              statusInfo
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_explain_transaction_status",
    {
      title: "Explain GenLayer Transaction Status",
      description: "Interpret a GenLayer transaction hash into appealability, finality phase, and likely next step.",
      inputSchema: {
        txId: z.string().min(1).describe("Transaction hash with 0x prefix."),
        timestamp: z.number().int().positive().optional().describe("Optional unix timestamp override for GenLayer status methods.")
      },
      annotations: {
        title: "Explain GenLayer Transaction Status",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ txId, timestamp }) => {
      const inspection = await rpcService.inspectTransaction({
        txId,
        ...(timestamp !== undefined ? { timestamp } : {})
      });
      const statusInfo = interpretTransactionStatus(inspection.status);
      const recommendation = statusInfo.isFinal
        ? "Transaction is in a terminal phase. Use the receipt or trace tools for post-mortem analysis."
        : statusInfo.isAppealable
          ? "Transaction appears to be inside the appeal window. Monitor it closely or inspect trace data if your node exposes debug methods."
          : "Transaction is still progressing through consensus. Poll again or use wait_for_transaction.";

      return {
        content: [
          {
            type: "text",
            text: formatJson({
              txId,
              rawStatus: inspection.status,
              statusInfo,
              recommendation
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_call_contract",
    {
      title: "Execute GenLayer gen_call",
      description: "Execute a live gen_call request for read, write-simulation, or deploy-simulation against the configured GenLayer RPC endpoint.",
      inputSchema: {
        from: z.string().min(1).describe("Caller address."),
        to: z.string().optional().describe("Target contract address. Omit for deploy requests if the node accepts that shape."),
        data: z.string().min(1).describe("Hex-encoded call data payload."),
        type: z.enum(["read", "write", "deploy"]).describe("GenLayer call type."),
        blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe("Optional hex-encoded block number."),
        status: z.enum(["accepted", "finalized"]).optional().describe("Optional state snapshot filter."),
        value: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe("Optional hex-encoded value to send."),
        leader_results: z.array(z.string()).nullable().optional().describe("Optional validator-mode leader results.")
      },
      annotations: {
        title: "Execute GenLayer gen_call"
      }
    },
    async ({ from, to, data, type, blockNumber, status, value, leader_results }) => {
      const request = {
        from,
        data,
        type
      } as const;
      const result = await rpcService.genCall({
        ...request,
        ...(to ? { to } : {}),
        ...(blockNumber ? { blockNumber } : {}),
        ...(status ? { status } : {}),
        ...(value ? { value } : {}),
        ...(leader_results !== undefined ? { leader_results } : {})
      });

      return {
        content: [
          {
            type: "text",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_contract_schema",
    {
      title: "Get GenLayer Contract Schema",
      description: "Derive the schema/interface for base64-encoded GenLayer contract code.",
      inputSchema: {
        code: z.string().min(1).describe("Base64-encoded contract code.")
      },
      annotations: {
        title: "Get GenLayer Contract Schema",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ code }) => {
      const result = await rpcService.getContractSchema(code).catch((error) => {
        return unsupportedContractRpcEnvelope("get_contract_schema", error);
      });
      if (isCanonicalEnvelope(result)) {
        return textEnvelope(result);
      }
      return {
        content: [
          {
            type: "text",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_contract_state",
    {
      title: "Get GenLayer Contract State",
      description: "Fetch the live state blob for a deployed GenLayer contract from the configured RPC endpoint.",
      inputSchema: {
        address: z.string().min(1).describe("Contract address to inspect."),
        blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe("Optional hex-encoded block number."),
        status: z.enum(["accepted", "finalized"]).optional().describe("Optional state snapshot filter.")
      },
      annotations: {
        title: "Get GenLayer Contract State",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, blockNumber, status }) => {
      const result = await rpcService.getContractState({
        address,
        ...(blockNumber ? { blockNumber } : {}),
        ...(status ? { status } : {})
      }).catch((error) => {
        return unsupportedContractRpcEnvelope("get_contract_state", error);
      });
      if (isCanonicalEnvelope(result)) {
        return textEnvelope(result);
      }
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              address,
              blockNumber,
              status,
              result
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_contract_code",
    {
      title: "Get GenLayer Contract Code",
      description: "Fetch the deployed base64 code blob for a GenLayer contract from the configured RPC endpoint.",
      inputSchema: {
        address: z.string().min(1).describe("Contract address to inspect."),
        blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe("Optional hex-encoded block number."),
        status: z.enum(["accepted", "finalized"]).optional().describe("Optional state snapshot filter.")
      },
      annotations: {
        title: "Get GenLayer Contract Code",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, blockNumber, status }) => {
      const result = await rpcService.getContractCode({
        address,
        ...(blockNumber ? { blockNumber } : {}),
        ...(status ? { status } : {})
      }).catch((error) => {
        return unsupportedContractRpcEnvelope("get_contract_code", error);
      });
      if (isCanonicalEnvelope(result)) {
        return textEnvelope(result);
      }
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              address,
              blockNumber,
              status,
              result
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_contract_snapshot",
    {
      title: "Get GenLayer Contract Snapshot",
      description: "Fetch contract state, deployed code, and derived schema in one call.",
      inputSchema: {
        address: z.string().min(1).describe("Contract address to inspect."),
        blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe("Optional hex-encoded block number."),
        status: z.enum(["accepted", "finalized"]).optional().describe("Optional state snapshot filter.")
      },
      annotations: {
        title: "Get GenLayer Contract Snapshot",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address, blockNumber, status }) => {
      const result = await rpcService.contractSnapshot({
        address,
        ...(blockNumber ? { blockNumber } : {}),
        ...(status ? { status } : {})
      }).catch((error) => {
        return unsupportedContractRpcEnvelope("get_contract_snapshot", error);
      });
      if (isCanonicalEnvelope(result)) {
        return textEnvelope(result);
      }
      return {
        content: [
          {
            type: "text",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_run_contract_report",
    {
      title: "Run Contract Report",
      description: "Orchestrate network context, contract snapshot, interface summary, workflow plan, and default action plans into one contract report.",
      inputSchema: {
        address: z.string().min(1).describe("Contract address to inspect.")
      },
      annotations: {
        title: "Run Contract Report",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ address }) => {
      const network = await buildNetworkStatusSnapshot();
      const contract = await buildContractComposite(address).catch((error) => {
        return unsupportedContractRpcEnvelope("run_contract_report", error);
      });
      if (isCanonicalEnvelope(contract)) {
        return textEnvelope(
          makeCanonicalResponse({
            kind: "contract_report",
            summary: `Contract report is not available for ${address} on this endpoint.`,
            currentState: {
              address,
              endpoint: rpcService.getSnapshot().endpoint
            },
            blockers: contract.blockers,
            nextActions: contract.next_actions,
            fallbacks: contract.fallbacks,
            data: {
              network,
              unsupported: contract
            }
          })
        );
      }

      return {
        content: [
          {
            type: "text",
            text: formatJson(
              makeCanonicalResponse({
                kind: "contract_report",
                summary: `Built contract report for ${address}.`,
                currentState: {
                  address,
                  viewMethodCount: contract.interface.viewMethods.length,
                  writeMethodCount: contract.interface.writeMethods.length
                },
                blockers: [],
                nextActions: contract.interface.viewMethods.length > 0 || contract.interface.writeMethods.length > 0
                  ? [
                      "Use the default plans in the report for the next read or write step.",
                      "If persistent tracking is needed, start a workflow session."
                    ]
                  : ["Review the schema and snapshot because no callable methods were detected."],
                fallbacks: ["If endpoint capabilities are limited, continue with planning and reporting layers only."],
                data: {
                  address,
                  network,
                  contract
                }
              })
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_transaction_status",
    {
      title: "Get GenLayer Transaction Status",
      description: "Fetch the lightweight consensus status for a GenLayer transaction.",
      inputSchema: {
        txId: z.string().min(1).describe("Transaction hash with 0x prefix."),
        timestamp: z.number().int().positive().optional().describe("Optional unix timestamp override.")
      },
      annotations: {
        title: "Get GenLayer Transaction Status",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ txId, timestamp }) => {
      const result = await rpcService.getTransactionStatus({
        txId,
        ...(timestamp !== undefined ? { timestamp } : {})
      });
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              txId,
              timestamp,
              result
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_transaction_receipt",
    {
      title: "Get GenLayer Transaction Receipt",
      description: "Fetch the full receipt for a processed GenLayer transaction.",
      inputSchema: {
        txId: z.string().min(1).describe("Transaction hash with 0x prefix.")
      },
      annotations: {
        title: "Get GenLayer Transaction Receipt",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ txId }) => {
      const result = await rpcService.getTransactionReceipt({
        txId
      });
      return {
        content: [
          {
            type: "text",
            text: formatJson({
              txId,
              result
            })
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_syncing",
    {
      title: "Check GenLayer Sync Status",
      description: "Call the configured GenLayer RPC endpoint gen_syncing method.",
      inputSchema: {},
      annotations: {
        title: "Check GenLayer Sync Status",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async () => {
      const result = await rpcService.syncing();
      return {
        content: [
          {
            type: "text",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_refresh_docs",
    {
      title: "Refresh GenLayer Docs",
      description: "Force-refresh the cached GenLayer documentation bundle from the configured source.",
      inputSchema: {},
      annotations: {
        title: "Refresh GenLayer Docs",
        idempotentHint: true
      }
    },
    async () => {
      const snapshot = await service.getSnapshot(true);
      return {
        content: [
          {
            type: "text",
            text: [
              "GenLayer documentation refreshed.",
              `Source: ${snapshot.source}`,
              `Fetched at: ${snapshot.fetchedAt}`,
              `Sections: ${snapshot.sections.length}`
            ].join("\n")
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_search_docs",
    {
      title: "Search GenLayer Docs",
      description: "Search the GenLayer documentation bundle and return the most relevant sections.",
      inputSchema: {
        query: z.string().min(1).describe("Search query for the GenLayer docs."),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of results to return.")
      },
      annotations: {
        title: "Search GenLayer Docs",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ query, limit }) => {
      const results = await service.search(query, limit);
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(query, results)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_read_doc",
    {
      title: "Read GenLayer Doc",
      description: "Read a specific GenLayer documentation section by slug, path, title, or fuzzy query.",
      inputSchema: {
        section: z.string().min(1).describe("Section slug, path, title, or a fuzzy lookup query."),
        maxChars: z.number().int().min(500).max(40000).default(6000).describe("Maximum characters to return.")
      },
      annotations: {
        title: "Read GenLayer Doc",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ section, maxChars }) => {
      const match = await service.readSection(section);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No GenLayer documentation section matched "${section}".`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatSection(match, maxChars)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_doc_by_slug",
    {
      title: "Get GenLayer Doc By Slug",
      description: "Read a GenLayer documentation section by exact slug, path, resource URI, or docs URL.",
      inputSchema: {
        slug: z.string().min(1).describe("Exact section slug or path, for example understand-genlayer-protocol/core-concepts/genvm."),
        maxChars: z.number().int().min(500).max(40000).default(6000).describe("Maximum characters to return.")
      },
      annotations: {
        title: "Get GenLayer Doc By Slug",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ slug, maxChars }) => {
      const match = await service.getSectionBySlug(slug);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No exact GenLayer documentation section matched slug "${slug}".`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatSection(match, maxChars)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_list_sections",
    {
      title: "List GenLayer Doc Sections",
      description: "List available GenLayer documentation sections, optionally filtered by prefix text.",
      inputSchema: {
        prefix: z.string().optional().describe("Optional prefix or substring filter for titles, paths, or slugs."),
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum sections to list.")
      },
      annotations: {
        title: "List GenLayer Doc Sections",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ prefix, limit }) => {
      const sections = await service.listSections(prefix, limit);

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: prefix
                ? `No GenLayer documentation sections matched "${prefix}".`
                : "No GenLayer documentation sections are currently available."
            }
          ]
        };
      }

      const text = [
        `GenLayer documentation sections (${sections.length}):`,
        "",
        ...sections.map((section, index) => `${index + 1}. ${section.title} | ${section.path} | ${section.uri}`)
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_search_examples",
    {
      title: "Search GenLayer Examples",
      description: "Search GenLayer documentation sections that contain code blocks, commands, SDK usage, or configuration examples.",
      inputSchema: {
        query: z.string().min(1).describe("Search query for example-heavy GenLayer docs."),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of results to return.")
      },
      annotations: {
        title: "Search GenLayer Examples",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ query, limit }) => {
      const results = await service.searchExamples(query, limit);
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(query, results)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_get_related_docs",
    {
      title: "Get Related GenLayer Docs",
      description: "Find GenLayer documentation sections related to a given slug, path, title, URL, or fuzzy query.",
      inputSchema: {
        section: z.string().min(1).describe("Base section slug, path, title, URL, or query."),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of related sections to return.")
      },
      annotations: {
        title: "Get Related GenLayer Docs",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ section, limit }) => {
      const related = await service.getRelatedDocs(section, limit);
      if (!related) {
        return {
          content: [
            {
              type: "text",
              text: `No GenLayer documentation section matched "${section}" for related-doc lookup.`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatRelatedDocs(related.base, related.results)
          }
        ]
      };
    }
  );

  server.registerTool(
    "genlayer_list_topics",
    {
      title: "List GenLayer Topics",
      description: "List top-level GenLayer documentation topics with section counts and example pages.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of topics to return.")
      },
      annotations: {
        title: "List GenLayer Topics",
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async ({ limit }) => {
      const topics = await service.listTopics(limit);
      return {
        content: [
          {
            type: "text",
            text: formatTopics(topics)
          }
        ]
      };
    }
  );

  server.registerResource(
    "genlayer-networks",
    "genlayer://protocol/networks",
    {
      title: "GenLayer Network Presets",
      description: "Documented GenLayer network presets, RPC URLs, and chain IDs.",
      mimeType: "application/json"
    },
    async () => {
      return {
        contents: [
          {
            uri: "genlayer://protocol/networks",
            mimeType: "application/json",
            text: buildNetworkPresetsDocument()
          }
        ]
      };
    }
  );

  server.registerResource(
    "genlayer-rpc-config",
    "genlayer://protocol/rpc-config",
    {
      title: "GenLayer RPC Configuration",
      description: "Configured GenLayer RPC endpoint and supported live protocol helper methods.",
      mimeType: "application/json"
    },
    async () => {
      return {
        contents: [
          {
            uri: "genlayer://protocol/rpc-config",
            mimeType: "application/json",
            text: buildRpcConfigDocument(rpcService.getSnapshot())
          }
        ]
      };
    }
  );

  server.registerResource(
    "genlayer-capabilities",
    "genlayer://protocol/capabilities",
    {
      title: "GenLayer Endpoint Capabilities",
      description: "Probed capabilities for the configured GenLayer deployment, including which HTTP and RPC surfaces are exposed.",
      mimeType: "application/json"
    },
    async () => {
      const report = await buildEndpointCapabilityReport();
      return {
        contents: [
          {
            uri: "genlayer://protocol/capabilities",
            mimeType: "application/json",
            text: formatJson(report)
          }
        ]
      };
    }
  );

  server.registerResource(
    "genlayer-autopilot",
    "genlayer://workflow/autopilot",
    {
      title: "GenLayer Autopilot Brief",
      description: "Single operator-grade brief for the configured endpoint, current contract context, and relevant GenLayer docs.",
      mimeType: "application/json"
    },
    async () => {
      const brief = await buildAutopilotBrief({ goal: "onboard" });
      return {
        contents: [
          {
            uri: "genlayer://workflow/autopilot",
            mimeType: "application/json",
            text: formatJson(brief)
          }
        ]
      };
    }
  );

  server.registerResource(
    "genlayer-workflow-sessions",
    "genlayer://workflow/sessions",
    {
      title: "GenLayer Workflow Sessions",
      description: "List of persisted GenLayer workflow sessions.",
      mimeType: "application/json"
    },
    async () => {
      const sessions = await workflowSessions.list(100);
      return {
        contents: [
          {
            uri: "genlayer://workflow/sessions",
            mimeType: "application/json",
            text: formatJson(sessions)
          }
        ]
      };
    }
  );

  const workflowSessionTemplate = new ResourceTemplate("genlayer://workflow/session/{id}", {
    list: undefined,
    complete: {
      id: async () => (await workflowSessions.list(100)).map((session) => session.id)
    }
  });

  server.registerResource(
    "genlayer-workflow-session",
    workflowSessionTemplate,
    {
      title: "GenLayer Workflow Session",
      description: "Persisted GenLayer workflow session with step completion state.",
      mimeType: "text/plain"
    },
    async (_uri, variables) => {
      const idValue = variables.id;
      const id = Array.isArray(idValue) ? idValue[0] : idValue;
      if (!id) {
        throw new Error("Missing workflow session id.");
      }

      const session = await workflowSessions.get(id);
      if (!session) {
        throw new Error(`Unknown workflow session "${id}".`);
      }

      return {
        contents: [
          {
            uri: `genlayer://workflow/session/${encodeURIComponent(id)}`,
            mimeType: "text/plain",
            text: formatWorkflowSession(session)
          }
        ]
      };
    }
  );

  const transactionTemplate = new ResourceTemplate("genlayer://protocol/transaction/{txId}", {
    list: undefined,
    complete: {
      txId: async () => []
    }
  });

  server.registerResource(
    "genlayer-transaction",
    transactionTemplate,
    {
      title: "GenLayer Transaction Snapshot",
      description: "Combined GenLayer and Ethereum transaction inspection for a specific transaction hash.",
      mimeType: "application/json"
    },
    async (_uri, variables) => {
      const txIdValue = variables.txId;
      const txId = Array.isArray(txIdValue) ? txIdValue[0] : txIdValue;

      if (!txId) {
        throw new Error("Missing transaction hash.");
      }

      const result = await rpcService.inspectTransaction({ txId });
      return {
        contents: [
          {
            uri: `genlayer://protocol/transaction/${encodeURIComponent(txId)}`,
            mimeType: "application/json",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  const transactionReportTemplate = new ResourceTemplate("genlayer://protocol/transaction/{txId}/report", {
    list: undefined,
    complete: {
      txId: async () => []
    }
  });

  server.registerResource(
    "genlayer-transaction-report",
    transactionReportTemplate,
    {
      title: "GenLayer Transaction Report",
      description: "Waited or immediate transaction report with status interpretation and optional trace data when exposed.",
      mimeType: "application/json"
    },
    async (_uri, variables) => {
      const txIdValue = variables.txId;
      const txId = Array.isArray(txIdValue) ? txIdValue[0] : txIdValue;

      if (!txId) {
        throw new Error("Missing transaction hash.");
      }

      const inspection = await rpcService.inspectTransaction({ txId });
      const statusInfo = interpretTransactionStatus(inspection.status);
      const trace = await rpcService.debugTraceTransaction({ txID: txId, round: 0 }).catch((error) => ({
        unavailable: true,
        error: error instanceof Error ? error.message : String(error)
      }));

      return {
        contents: [
          {
            uri: `genlayer://protocol/transaction/${encodeURIComponent(txId)}/report`,
            mimeType: "application/json",
            text: formatJson({
              txId,
              inspection,
              statusInfo,
              recommendation: buildStatusRecommendation(statusInfo),
              trace
            })
          }
        ]
      };
    }
  );

  const contractStateTemplate = new ResourceTemplate("genlayer://protocol/contract/{address}/state", {
    list: undefined,
    complete: {
      address: async () => []
    }
  });

  server.registerResource(
    "genlayer-contract-state",
    contractStateTemplate,
    {
      title: "GenLayer Contract State",
      description: "Current accepted-state snapshot for a contract address through gen_getContractState.",
      mimeType: "application/json"
    },
    async (_uri, variables) => {
      const addressValue = variables.address;
      const address = Array.isArray(addressValue) ? addressValue[0] : addressValue;

      if (!address) {
        throw new Error("Missing contract address.");
      }

      const result = await rpcService.getContractState({ address });
      return {
        contents: [
          {
            uri: `genlayer://protocol/contract/${encodeURIComponent(address)}/state`,
            mimeType: "application/json",
            text: formatJson({
              address,
              status: "accepted",
              result
            })
          }
        ]
      };
    }
  );

  const contractSnapshotTemplate = new ResourceTemplate("genlayer://protocol/contract/{address}/snapshot", {
    list: undefined,
    complete: {
      address: async () => []
    }
  });

  server.registerResource(
    "genlayer-contract-snapshot",
    contractSnapshotTemplate,
    {
      title: "GenLayer Contract Snapshot",
      description: "Combined state, code, and schema snapshot for a specific deployed contract.",
      mimeType: "application/json"
    },
    async (_uri, variables) => {
      const addressValue = variables.address;
      const address = Array.isArray(addressValue) ? addressValue[0] : addressValue;

      if (!address) {
        throw new Error("Missing contract address.");
      }

      const result = await rpcService.contractSnapshot({ address });
      return {
        contents: [
          {
            uri: `genlayer://protocol/contract/${encodeURIComponent(address)}/snapshot`,
            mimeType: "application/json",
            text: formatJson(result)
          }
        ]
      };
    }
  );

  const contractPlaybookTemplate = new ResourceTemplate("genlayer://protocol/contract/{address}/playbook", {
    list: undefined,
    complete: {
      address: async () => []
    }
  });

  server.registerResource(
    "genlayer-contract-playbook",
    contractPlaybookTemplate,
    {
      title: "GenLayer Contract Playbook",
      description: "Schema-aware deployment and interaction playbook for a deployed contract.",
      mimeType: "text/plain"
    },
    async (_uri, variables) => {
      const addressValue = variables.address;
      const address = Array.isArray(addressValue) ? addressValue[0] : addressValue;

      if (!address) {
        throw new Error("Missing contract address.");
      }

      const snapshot = await rpcService.contractSnapshot({ address });
      const summary = normalizeContractSchema(snapshot.schema);
      const preset = inferCurrentNetworkPreset();
      const text = buildContractPlaybook({
        address,
        chainLabel: preset?.label ?? "custom",
        schema: summary
      });

      return {
        contents: [
          {
            uri: `genlayer://protocol/contract/${encodeURIComponent(address)}/playbook`,
            mimeType: "text/plain",
            text
          }
        ]
      };
    }
  );

  const contractReportTemplate = new ResourceTemplate("genlayer://protocol/contract/{address}/report", {
    list: undefined,
    complete: {
      address: async () => []
    }
  });

  server.registerResource(
    "genlayer-contract-report",
    contractReportTemplate,
    {
      title: "GenLayer Contract Report",
      description: "Composed contract report with network context, snapshot, interface, workflow, and default plans.",
      mimeType: "application/json"
    },
    async (_uri, variables) => {
      const addressValue = variables.address;
      const address = Array.isArray(addressValue) ? addressValue[0] : addressValue;

      if (!address) {
        throw new Error("Missing contract address.");
      }

      const network = await buildNetworkStatusSnapshot();
      const contract = await buildContractComposite(address);

      return {
        contents: [
          {
            uri: `genlayer://protocol/contract/${encodeURIComponent(address)}/report`,
            mimeType: "application/json",
            text: formatJson({
              address,
              network,
              contract
            })
          }
        ]
      };
    }
  );

  const contractPlansTemplate = new ResourceTemplate("genlayer://protocol/contract/{address}/plans", {
    list: undefined,
    complete: {
      address: async () => []
    }
  });

  server.registerResource(
    "genlayer-contract-plans",
    contractPlansTemplate,
    {
      title: "GenLayer Contract Plans",
      description: "Default workflow and method-level action plans for a deployed contract.",
      mimeType: "text/plain"
    },
    async (_uri, variables) => {
      const addressValue = variables.address;
      const address = Array.isArray(addressValue) ? addressValue[0] : addressValue;

      if (!address) {
        throw new Error("Missing contract address.");
      }

      const snapshot = await rpcService.contractSnapshot({ address });
      const summary = normalizeContractSchema(snapshot.schema);
      const preset = inferCurrentNetworkPreset();
      const workflow = buildWorkflowPlan({
        address,
        chainLabel: preset?.label ?? "custom",
        schema: summary
      });

      const defaultReadPlan = summary.viewMethods[0]
        ? buildExecutionPlan({
            action: "read",
            address,
            args: [],
            chainLabel: preset?.label ?? "custom",
            methodName: summary.viewMethods[0].name,
            schema: summary
          })
        : null;
      const defaultWritePlan = summary.writeMethods[0]
        ? buildExecutionPlan({
            action: "write",
            address,
            args: [],
            chainLabel: preset?.label ?? "custom",
            methodName: summary.writeMethods[0].name,
            schema: summary,
            statusTarget: "finalized"
          })
        : null;

      const parts = [
        formatWorkflowPlan(workflow),
        "",
        "Default Read Plan:",
        defaultReadPlan ? formatExecutionPlan(defaultReadPlan) : "No view methods available.",
        "",
        "Default Write Plan:",
        defaultWritePlan ? formatExecutionPlan(defaultWritePlan) : "No write methods available."
      ];

      return {
        contents: [
          {
            uri: `genlayer://protocol/contract/${encodeURIComponent(address)}/plans`,
            mimeType: "text/plain",
            text: parts.join("\n")
          }
        ]
      };
    }
  );

  const contractMethodPlanTemplate = new ResourceTemplate("genlayer://protocol/contract/{address}/method/{method}/plan/{action}", {
    list: undefined,
    complete: {
      address: async () => [],
      method: async () => [],
      action: async (value) => ["read", "write"].filter((item) => item.startsWith(value))
    }
  });

  server.registerResource(
    "genlayer-contract-method-plan",
    contractMethodPlanTemplate,
    {
      title: "GenLayer Contract Method Plan",
      description: "Default schema-validated plan for a specific deployed contract method.",
      mimeType: "text/plain"
    },
    async (_uri, variables) => {
      const addressValue = variables.address;
      const methodValue = variables.method;
      const actionValue = variables.action;
      const address = Array.isArray(addressValue) ? addressValue[0] : addressValue;
      const method = Array.isArray(methodValue) ? methodValue[0] : methodValue;
      const action = Array.isArray(actionValue) ? actionValue[0] : actionValue;

      if (!address || !method || (action !== "read" && action !== "write")) {
        throw new Error("Missing or invalid address/method/action.");
      }

      const snapshot = await rpcService.contractSnapshot({ address });
      const summary = normalizeContractSchema(snapshot.schema);
      const preset = inferCurrentNetworkPreset();
      const plan = buildExecutionPlan({
        action,
        address,
        args: [],
        chainLabel: preset?.label ?? "custom",
        methodName: method,
        schema: summary,
        ...(action === "write" ? { statusTarget: "finalized" as const } : {})
      });

      return {
        contents: [
          {
            uri: `genlayer://protocol/contract/${encodeURIComponent(address)}/method/${encodeURIComponent(method)}/plan/${action}`,
            mimeType: "text/plain",
            text: formatExecutionPlan(plan)
          }
        ]
      };
    }
  );

  server.registerResource(
    "genlayer-docs-index",
    "genlayer://docs/index",
    {
      title: "GenLayer Docs Index",
      description: "JSON index of the parsed GenLayer documentation bundle.",
      mimeType: "application/json"
    },
    async () => {
      const snapshot = await service.getSnapshot();
      return {
        contents: [
          {
            uri: "genlayer://docs/index",
            mimeType: "application/json",
            text: buildIndexDocument(snapshot)
          }
        ]
      };
    }
  );

  const sectionTemplate = new ResourceTemplate("genlayer://docs/section/{slug}", {
    list: async () => {
      const sections = await service.listSections(undefined, 500);
      return {
        resources: buildResourceList(sections)
      };
    },
    complete: {
      slug: async (value) => {
        const sections = await service.listSections(value, 50);
        return sections.map((section) => section.slug);
      }
    }
  });

  server.registerResource(
    "genlayer-doc-section",
    sectionTemplate,
    {
      title: "GenLayer Doc Section",
      description: "Individual GenLayer documentation sections exposed as resources.",
      mimeType: "text/markdown"
    },
    async (_uri, variables) => {
      const slugValue = variables.slug;
      const slug = Array.isArray(slugValue) ? slugValue[0] : slugValue;
      const match = slug ? await service.readSection(slug) : undefined;

      if (!match) {
        throw new Error(`Unknown GenLayer documentation slug: ${slug ?? "empty"}`);
      }

      return {
        contents: [
          {
            uri: match.uri,
            mimeType: "text/markdown",
            text: formatSection(match, 40000)
          }
        ]
      };
    }
  );
}

export async function startServer(): Promise<void> {
  if (process.argv.includes("--check")) {
    const snapshot = await service.getSnapshot();
    console.error(`Loaded ${snapshot.sections.length} GenLayer docs sections from ${snapshot.source}.`);
    console.error(`Example section: ${snapshot.sections[0]?.title ?? "none"}`);
    return;
  }

  const server = createDocsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function resolveContractSchema(address?: string, code?: string): Promise<unknown> {
  assertContractRpcSupported("resolve contract schema");
  if (code) {
    return rpcService.getContractSchema(code);
  }

  if (address) {
    const snapshot = await rpcService.contractSnapshot({ address });
    return snapshot.schema;
  }

  throw new Error("Provide either address or code.");
}

async function resolveContractSchemaFromAnySource(address?: string, code?: string, contractPath?: string): Promise<unknown> {
  assertContractRpcSupported("resolve contract schema from endpoint");
  if (code || address) {
    return resolveContractSchema(address, code);
  }

  if (contractPath) {
    const artifact = await loadContractArtifact(contractPath);
    return rpcService.getContractSchema(artifact.base64);
  }

  throw new Error("Provide at least one of address, code, or contractPath.");
}

function inferCurrentNetworkPreset() {
  const endpoint = rpcService.getSnapshot().endpoint.replace(/\/+$/, "");
  return listNetworkPresets().find((preset) => preset.rpcUrl.replace(/\/+$/, "") === endpoint);
}

function resolveEndpointProfile() {
  const endpoint = rpcService.getSnapshot().endpoint;
  const url = new URL(endpoint);
  const isHostedStudionet = url.hostname === "studio.genlayer.com" && url.pathname === "/api";

  if (isHostedStudionet) {
    return {
      mode: "studionet-hosted" as const,
      endpoint,
      contractRpcSupported: false,
      reason: "Hosted Studionet does not currently provide reliable contract RPC methods like gen_getContractState/gen_getContractCode/gen_getContractSchema."
    };
  }

  return {
    mode: "generic" as const,
    endpoint,
    contractRpcSupported: true,
    reason: null
  };
}

function assertContractRpcSupported(operation: string): void {
  const profile = resolveEndpointProfile();
  if (!profile.contractRpcSupported) {
    throw new Error(`${operation} is not supported on ${profile.mode} (${profile.endpoint}). ${profile.reason}`);
  }
}

function presetChainImport(label: string | undefined): string {
  switch (label) {
    case "Studionet":
      return "studionet";
    case "Bradbury Testnet":
      return "testnetBradbury";
    case "Asimov Testnet":
      return "testnetAsimov";
    case "Localnet":
      return "simulator";
    default:
      return "studionet";
  }
}

async function buildEndpointCapabilityReport() {
  const snapshot = rpcService.getSnapshot();
  const probes = await Promise.all([
    probe("health", async () => rpcService.health()),
    probe("balance", async () => rpcService.balance("")),
    probe("metrics", async () => rpcService.metrics()),
    probe("chainId", async () => rpcService.chainId()),
    probe("blockNumber", async () => rpcService.blockNumber()),
    probe("syncing", async () => rpcService.syncing()),
    probe("debugPing", async () => rpcService.debugPing()),
    probe("traceTransaction", async () => rpcService.debugTraceTransaction({ txID: "0x00", round: 0 }))
  ]);

  return {
    endpoint: snapshot.endpoint,
    healthEndpoint: snapshot.healthEndpoint,
    probes: Object.fromEntries(probes.map((probeResult) => [probeResult.name, probeResult.result])),
    documentedMethods: snapshot.methods
  };
}

async function probe(name: string, task: () => Promise<unknown>) {
  try {
    const result = await task();
    return {
      name,
      result: {
        exposed: true,
        sample: result
      }
    };
  } catch (error) {
    return {
      name,
      result: {
        exposed: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function buildAgentHandoff(input: {
  address?: string;
  contractPath?: string;
  goal: "deploy" | "read" | "write" | "debug" | "onboard";
  network: string;
  summary: ReturnType<typeof normalizeContractSchema>;
}): string {
  const lines: string[] = [];
  const firstRead = input.summary.viewMethods[0]?.name ?? null;
  const firstWrite = input.summary.writeMethods[0]?.name ?? null;

  lines.push(`Goal: ${input.goal}`);
  lines.push(`Network: ${input.network}`);
  if (input.address) {
    lines.push(`Address: ${input.address}`);
  }
  if (input.contractPath) {
    lines.push(`Contract path: ${input.contractPath}`);
  }
  lines.push("");
  lines.push("Ordered tool sequence:");
  lines.push("1. Call `genlayer_probe_endpoint_capabilities` and stop if chainId or blockNumber is not exposed.");
  lines.push("2. Call `genlayer_network_status` and record endpoint, chainId, blockNumber, and sync state.");

  if (input.contractPath && (input.goal === "deploy" || input.goal === "onboard")) {
    lines.push("3. Call `genlayer_load_contract_artifact` with the contract path.");
    lines.push("4. Call `genlayer_get_contract_interface` or `genlayer_generate_typescript_workflow` using that artifact-derived schema.");
    lines.push("5. Call `genlayer_plan_contract_action` with `action=deploy` and constructor args before any deployment.");
  } else if (input.address) {
    lines.push("3. Call `genlayer_get_contract_snapshot` with the target address.");
    lines.push("4. Call `genlayer_get_contract_interface` with the target address.");
  }

  if (firstRead && (input.goal === "read" || input.goal === "onboard")) {
    lines.push(`5. Call \`genlayer_plan_contract_action\` with \`action=read\` and \`methodName=${firstRead}\`.`);
  }
  if (firstWrite && (input.goal === "write" || input.goal === "onboard")) {
    lines.push(`6. Call \`genlayer_plan_contract_action\` with \`action=write\` and \`methodName=${firstWrite}\`.`);
    lines.push("7. After submission, call `genlayer_run_transaction_report` with the returned tx hash.");
  }
  if (input.goal === "debug") {
    lines.push("5. Call `genlayer_run_transaction_report` if a tx hash exists.");
    lines.push("6. Call `genlayer_trace_transaction` only if capability probing says debug trace is exposed.");
  }

  lines.push("");
  lines.push("Success conditions:");
  lines.push("- Endpoint capability probe succeeds for the required surfaces.");
  lines.push("- Contract schema is normalized into clear view/write methods.");
  lines.push("- Any planned action validates arguments cleanly.");
  lines.push("- Any submitted transaction is followed by a transaction report.");
  lines.push("");
  lines.push("Fallback rules:");
  lines.push("- If debug trace is not exposed, skip trace and rely on inspect + explain + receipt.");
  lines.push("- If `/metrics` or `/balance` are not exposed, do not treat that as a fatal failure.");
  lines.push("- If no write methods exist, do not fabricate a write workflow.");

  return lines.join("\n");
}

async function buildAutopilotBrief(input: {
  address?: string;
  code?: string;
  contractPath?: string;
  goal: "deploy" | "read" | "write" | "debug" | "onboard";
}) {
  const capabilities = await buildEndpointCapabilityReport();
  const network = await buildNetworkStatusSnapshot();
  const docs = await buildRelevantDocsBundle(input.goal);
  const capabilityState = summarizeCapabilities(capabilities);

  let contract: Awaited<ReturnType<typeof buildContractComposite>> | undefined;
  let handoff: string | undefined;
  let workflowText: string | undefined;
  let contractRpcIssue: ReturnType<typeof makeCanonicalResponse> | undefined;

  if (input.address || input.code || input.contractPath) {
    const schema = await resolveContractSchemaFromAnySource(input.address, input.code, input.contractPath).catch((error) => {
      return unsupportedContractRpcEnvelope("autopilot_brief_contract_context", error);
    });

    if (isCanonicalEnvelope(schema)) {
      contractRpcIssue = schema;
    } else {
      const summary = normalizeContractSchema(schema);
      const preset = inferCurrentNetworkPreset();
      handoff = buildAgentHandoff({
        goal: input.goal,
        network: preset?.label ?? "custom",
        summary,
        ...(input.address ? { address: input.address } : {}),
        ...(input.contractPath ? { contractPath: input.contractPath } : {})
      });
      workflowText = formatWorkflowPlan(
        buildWorkflowPlan({
          chainLabel: preset?.label ?? "custom",
          schema: summary,
          ...(input.address ? { address: input.address } : {}),
          ...(input.contractPath ? { contractPath: input.contractPath } : {})
        })
      );

      if (input.address) {
        contract = await buildContractComposite(input.address).catch(() => undefined);
      }
    }
  }

  const blockers = extractCapabilityBlockers(capabilities);
  const fallbacks = [
    "If a required capability is missing, stay within capability-supported flows such as docs, reports, and basic network inspection."
  ];
  if (contractRpcIssue) {
    blockers.push(...contractRpcIssue.blockers);
    fallbacks.push(...contractRpcIssue.fallbacks);
  }

  const orderedNextActions = buildOrderedNextActions({
    capabilities: capabilityState,
    goal: input.goal,
    hasAddress: Boolean(input.address),
    hasContractPath: Boolean(input.contractPath)
  });

  return {
    goal: input.goal,
    orderedNextActions,
    capabilities,
    capabilityState,
    blockers,
    network,
    ...(contract ? { contract } : {}),
    ...(handoff ? { handoff } : {}),
    ...(workflowText ? { workflowText } : {}),
    ...(contractRpcIssue ? { contractRpcIssue } : {}),
    docs
  };
}

async function buildRelevantDocsBundle(goal: "deploy" | "read" | "write" | "debug" | "onboard") {
  const queryMap = {
    deploy: "deploy intelligent contracts genlayer-js",
    read: "reading data intelligent contracts genlayer-js",
    write: "writing data intelligent contracts genlayer-js transaction status",
    debug: "transaction execution appeals debug tracing",
    onboard: "intelligent contracts genlayer-js deployment reading data"
  } as const;

  const query = queryMap[goal];
  const [general, examples] = await Promise.all([
    service.search(query, 4),
    service.searchExamples(query, 4)
  ]);

  return {
    query,
    general: general.map((item) => ({
      title: item.section.title,
      path: item.section.path,
      url: item.section.publicUrl,
      snippet: item.snippet
    })),
    examples: examples.map((item) => ({
      title: item.section.title,
      path: item.section.path,
      url: item.section.publicUrl,
      snippet: item.snippet
    }))
  };
}

function buildOrderedNextActions(input: {
  capabilities: ReturnType<typeof summarizeCapabilities>;
  goal: "deploy" | "read" | "write" | "debug" | "onboard";
  hasAddress: boolean;
  hasContractPath: boolean;
}) {
  const actions = ["Probe endpoint capabilities with `genlayer_probe_endpoint_capabilities`."];

  if (input.capabilities.chainReady) {
    actions.push("Capture live network context with `genlayer_network_status`.");
  } else {
    actions.push("Stop and fix endpoint connectivity first because chainId or blockNumber is unavailable.");
    return actions;
  }

  if (input.hasContractPath) {
    actions.push("Load the local artifact with `genlayer_load_contract_artifact`.");
  }
  if (input.hasAddress) {
    actions.push("Fetch the deployed contract snapshot with `genlayer_get_contract_snapshot`.");
  }

  switch (input.goal) {
    case "deploy":
      actions.push("Generate a deploy action plan with `genlayer_plan_contract_action`.");
      actions.push("Generate SDK code with `genlayer_generate_typescript_workflow`.");
      break;
    case "read":
      actions.push("Generate a read plan with `genlayer_plan_contract_action`.");
      break;
    case "write":
      actions.push("Generate a write plan with `genlayer_plan_contract_action`.");
      actions.push("After submission, run `genlayer_run_transaction_report`.");
      break;
    case "debug":
      actions.push("Run `genlayer_run_transaction_report` for the target tx.");
      if (input.capabilities.traceAvailable) {
        actions.push("Use `genlayer_trace_transaction` because the endpoint exposes trace support.");
      } else {
        actions.push("Skip trace and rely on inspect/explain/report because trace support is not exposed.");
      }
      break;
    case "onboard":
      actions.push("Generate an agent handoff with `genlayer_generate_agent_handoff`.");
      actions.push("Generate a workflow plan with `genlayer_plan_contract_workflow`.");
      break;
  }

  return actions;
}


function unsupportedContractRpcEnvelope(operation: string, error: unknown) {
  const profile = resolveEndpointProfile();
  const message = error instanceof Error ? error.message : String(error);

  return makeCanonicalResponse({
    kind: "unsupported_contract_rpc",
    summary: `Contract RPC operation "${operation}" is not supported on this endpoint.`,
    currentState: {
      operation,
      endpoint: profile.endpoint,
      endpoint_mode: profile.mode
    },
    blockers: [profile.reason ?? message],
    nextActions: [
      "Use docs, network status, capability probing, and transaction reporting on this endpoint.",
      "For live contract introspection, use a full GenLayer node endpoint instead of hosted Studionet."
    ],
    fallbacks: [
      "If you already have a transaction hash, use `genlayer_run_transaction_report`.",
      "If you need deploy or execution flows, use CLI/SDK against a supported network path."
    ],
    data: {
      upstream_error: message
    }
  });
}



function sessionStateSnapshot(session: Awaited<ReturnType<WorkflowSessionStore["get"]>> extends infer T ? Exclude<T, undefined> : never) {
  return {
    id: session.id,
    goal: session.goal,
    network: session.network,
    completedSteps: session.completedSteps,
    totalSteps: session.totalSteps,
    progressRatio: session.totalSteps === 0 ? 0 : session.completedSteps / session.totalSteps
  };
}

function workflowSessionNextActions(session: Awaited<ReturnType<WorkflowSessionStore["get"]>> extends infer T ? Exclude<T, undefined> : never) {
  for (const phase of session.phases) {
    for (const step of phase.steps) {
      if (step.status !== "completed") {
        return [
          `Run the next pending step: ${step.name} using \`${step.tool}\`.`,
          "After completing it, mark the step with `genlayer_update_workflow_step`."
        ];
      }
    }
  }

  return ["All workflow steps are complete. Review the final reports or start a new session for the next task."];
}

function extractCapabilityBlockers(report: { probes: Record<string, { exposed: boolean }> }) {
  const blockers: string[] = [];
  const chainId = report.probes.chainId;
  const blockNumber = report.probes.blockNumber;

  if (!chainId?.exposed) {
    blockers.push("Endpoint does not expose chainId.");
  }
  if (!blockNumber?.exposed) {
    blockers.push("Endpoint does not expose blockNumber.");
  }

  return blockers;
}

function capabilityDrivenNextActions(report: { probes: Record<string, { exposed: boolean }> }) {
  const capabilityState = summarizeCapabilities(report);
  const actions = capabilityState.chainReady
    ? ["Use `genlayer_network_status` to capture the live network context."]
    : ["Do not proceed with protocol workflows until chainId and blockNumber are available."];

  if (capabilityState.traceAvailable) {
    actions.push("Trace-based debugging is available for transaction diagnostics.");
  } else {
    actions.push("Trace-based debugging is unavailable; prefer inspect, explain, and report tools.");
  }

  return actions;
}

function summarizeCapabilities(report: { probes: Record<string, { exposed: boolean }> }) {
  return {
    chainReady: Boolean(report.probes.chainId?.exposed && report.probes.blockNumber?.exposed),
    traceAvailable: Boolean(report.probes.traceTransaction?.exposed),
    metricsAvailable: Boolean(report.probes.metrics?.exposed),
    balanceAvailable: Boolean(report.probes.balance?.exposed),
    syncAvailable: Boolean(report.probes.syncing?.exposed)
  };
}

function flattenWorkflowPlanActions(plan: { phases: Array<{ steps: Array<{ name: string; tool: string }> }> }) {
  return plan.phases.flatMap((phase) =>
    phase.steps.map((step) => `${step.name} with \`${step.tool}\`.`)
  );
}

function transactionReportNextActions(statusInfo: ReturnType<typeof interpretTransactionStatus>, hasAddress: boolean) {
  if (statusInfo.isFinal && statusInfo.isSuccessfulTerminal) {
    return hasAddress
      ? ["Review the attached contract snapshot and proceed with the next contract action plan."]
      : ["Use the transaction receipt as the handoff point for downstream workflow steps."];
  }
  if (statusInfo.isAppealable) {
    return ["Continue monitoring the transaction and inspect trace output if the endpoint exposes it."];
  }
  if (statusInfo.isFinal) {
    return ["Inspect the receipt and trace outputs to determine why the transaction failed."];
  }

  return ["Continue polling with `genlayer_wait_for_transaction` or rerun this report later."];
}

function buildStatusRecommendation(statusInfo: ReturnType<typeof interpretTransactionStatus>): string {
  if (statusInfo.isFinal && statusInfo.isSuccessfulTerminal) {
    return "Transaction is finalized successfully. Use the receipt, snapshot, and follow-up plans for downstream workflow steps.";
  }
  if (statusInfo.isFinal && !statusInfo.isSuccessfulTerminal) {
    return "Transaction is in a terminal non-success state. Inspect the receipt and trace output for post-mortem analysis.";
  }
  if (statusInfo.isAppealable) {
    return "Transaction appears to be in or near the appeal window. Continue monitoring and use trace data when available.";
  }
  return "Transaction is still progressing. Continue polling or rerun the report later.";
}

async function buildNetworkStatusSnapshot() {
  const snapshot = rpcService.getSnapshot();
  const [health, chainId, blockNumber, syncing] = await Promise.all([
    rpcService.health().catch((error) => ({
      unavailable: true,
      error: error instanceof Error ? error.message : String(error)
    })),
    rpcService.chainId().catch((error) => ({
      unavailable: true,
      error: error instanceof Error ? error.message : String(error)
    })),
    rpcService.blockNumber().catch((error) => ({
      unavailable: true,
      error: error instanceof Error ? error.message : String(error)
    })),
    rpcService.syncing().catch((error) => ({
      unavailable: true,
      error: error instanceof Error ? error.message : String(error)
    }))
  ]);

  return {
    endpoint: snapshot.endpoint,
    healthEndpoint: snapshot.healthEndpoint,
    health,
    chainId,
    blockNumber,
    syncing
  };
}

async function buildContractComposite(address: string) {
  const snapshot = await rpcService.contractSnapshot({ address });
  const summary = normalizeContractSchema(snapshot.schema);
  const preset = inferCurrentNetworkPreset();
  const workflow = buildWorkflowPlan({
    address,
    chainLabel: preset?.label ?? "custom",
    schema: summary
  });
  const readPlan = summary.viewMethods[0]
    ? buildExecutionPlan({
        action: "read",
        address,
        args: [],
        chainLabel: preset?.label ?? "custom",
        methodName: summary.viewMethods[0].name,
        schema: summary
      })
    : null;
  const writePlan = summary.writeMethods[0]
    ? buildExecutionPlan({
        action: "write",
        address,
        args: [],
        chainLabel: preset?.label ?? "custom",
        methodName: summary.writeMethods[0].name,
        schema: summary,
        statusTarget: "finalized"
      })
    : null;

  return {
    snapshot,
    interface: {
      constructorParams: summary.constructorParams,
      viewMethods: summary.viewMethods,
      writeMethods: summary.writeMethods
    },
    workflow,
    defaultPlans: {
      read: readPlan,
      write: writePlan
    }
  };
}
