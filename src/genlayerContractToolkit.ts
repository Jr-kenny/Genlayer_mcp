interface RawSchemaMethod {
  kwparams?: Record<string, unknown>;
  params?: unknown[];
  payable?: boolean;
  readonly?: boolean;
  ret?: unknown;
}

interface RawSchema {
  ctor?: RawSchemaMethod;
  methods?: Record<string, RawSchemaMethod>;
}

export interface ContractParameter {
  name: string;
  type: string;
}

export interface NormalizedContractMethod {
  kind: "view" | "write";
  kwparams: string[];
  name: string;
  params: ContractParameter[];
  payable: boolean;
  returns: string | null;
}

export interface ContractInterfaceSummary {
  constructorParams: ContractParameter[];
  methods: NormalizedContractMethod[];
  viewMethods: NormalizedContractMethod[];
  writeMethods: NormalizedContractMethod[];
}

export interface ContractArgumentCheck {
  expectedType: string;
  name: string;
  ok: boolean;
  received: unknown;
  receivedType: string;
}

export interface ContractExecutionPlan {
  action: "deploy" | "read" | "write";
  address?: string;
  args: unknown[];
  callMode: "gen_call" | "genlayer-js";
  chainLabel?: string;
  contractPath?: string;
  from?: string;
  methodName?: string;
  payable: boolean;
  statusTarget?: "accepted" | "finalized";
  validation: {
    checks: ContractArgumentCheck[];
    ok: boolean;
    problems: string[];
  };
  value?: string;
}

export interface ContractWorkflowStep {
  details: string;
  name: string;
  tool: string;
}

export interface ContractWorkflowPlan {
  contractPath?: string;
  network: string;
  phases: Array<{
    name: string;
    steps: ContractWorkflowStep[];
  }>;
  recommendedReadMethod: string | null;
  recommendedWriteMethod: string | null;
  targetAddress?: string;
}

export function normalizeContractSchema(schema: unknown): ContractInterfaceSummary {
  const parsed = isRecord(schema) ? (schema as RawSchema) : {};
  const methods = Object.entries(parsed.methods ?? {})
    .map(([name, method]) => normalizeMethod(name, method))
    .filter((method): method is NormalizedContractMethod => Boolean(method));

  const viewMethods = methods.filter((method) => method.kind === "view");
  const writeMethods = methods.filter((method) => method.kind === "write");

  return {
    constructorParams: normalizeParams(parsed.ctor?.params),
    methods,
    viewMethods,
    writeMethods
  };
}

export function formatContractInterface(summary: ContractInterfaceSummary): string {
  const lines: string[] = [];

  lines.push("Constructor:");
  if (summary.constructorParams.length === 0) {
    lines.push("  - none");
  } else {
    for (const param of summary.constructorParams) {
      lines.push(`  - ${param.name}: ${param.type}`);
    }
  }

  lines.push("");
  lines.push("View Methods:");
  if (summary.viewMethods.length === 0) {
    lines.push("  - none");
  } else {
    for (const method of summary.viewMethods) {
      lines.push(`  - ${formatMethodSignature(method)}`);
    }
  }

  lines.push("");
  lines.push("Write Methods:");
  if (summary.writeMethods.length === 0) {
    lines.push("  - none");
  } else {
    for (const method of summary.writeMethods) {
      const payable = method.payable ? " payable" : "";
      lines.push(`  - ${formatMethodSignature(method)}${payable}`);
    }
  }

  return lines.join("\n");
}

export function buildTypeScriptInteractionGuide(input: {
  address?: string;
  chainImport?: string;
  chainLabel?: string;
  contractPath?: string;
  schema: ContractInterfaceSummary;
}): string {
  const address = input.address ?? "0xYourContractAddress";
  const chainImport = input.chainImport ?? "studionet";
  const chainLabel = input.chainLabel ?? "studionet";
  const firstView = input.schema.viewMethods[0];
  const firstWrite = input.schema.writeMethods[0];

  const sections: string[] = [];

  sections.push("```ts");
  sections.push("import { createClient, createAccount } from 'genlayer-js';");
  sections.push(`import { ${chainImport} } from 'genlayer-js/chains';`);
  sections.push("import { TransactionStatus } from 'genlayer-js/types';");
  sections.push("");
  sections.push("const account = createAccount();");
  sections.push("const client = createClient({");
  sections.push(`  chain: ${chainLabel},`);
  sections.push("  account,");
  sections.push("});");
  sections.push("```");

  if (input.contractPath) {
    sections.push("");
    sections.push("Deploy:");
    sections.push("```ts");
    sections.push("import { readFileSync } from 'fs';");
    sections.push("import path from 'path';");
    sections.push("");
    sections.push(`const contractCode = new Uint8Array(readFileSync(path.resolve(process.cwd(), '${input.contractPath}')));`);
    sections.push("await client.initializeConsensusSmartContract();");
    sections.push("const deployHash = await client.deployContract({");
    sections.push("  code: contractCode,");
    sections.push(`  args: ${exampleArgsArray(input.schema.constructorParams)},`);
    sections.push("});");
    sections.push("const deployReceipt = await client.waitForTransactionReceipt({");
    sections.push("  hash: deployHash,");
    sections.push("  status: TransactionStatus.FINALIZED,");
    sections.push("});");
    sections.push("```");
  }

  if (firstView) {
    sections.push("");
    sections.push("Read:");
    sections.push("```ts");
    sections.push("const readResult = await client.readContract({");
    sections.push(`  address: '${address}',`);
    sections.push(`  functionName: '${firstView.name}',`);
    sections.push(`  args: ${exampleArgsArray(firstView.params)},`);
    sections.push("});");
    sections.push("```");
  }

  if (firstWrite) {
    sections.push("");
    sections.push("Write:");
    sections.push("```ts");
    sections.push("const txHash = await client.writeContract({");
    sections.push(`  address: '${address}',`);
    sections.push(`  functionName: '${firstWrite.name}',`);
    sections.push(`  args: ${exampleArgsArray(firstWrite.params)},`);
    sections.push(`  value: ${firstWrite.payable ? "0n // replace with wei amount" : "0n"},`);
    sections.push("});");
    sections.push("const receipt = await client.waitForTransactionReceipt({");
    sections.push("  hash: txHash,");
    sections.push("  status: TransactionStatus.FINALIZED,");
    sections.push("});");
    sections.push("```");
  }

  return sections.join("\n");
}

export function buildContractPlaybook(input: {
  address?: string;
  contractPath?: string;
  chainLabel?: string;
  schema: ContractInterfaceSummary;
}): string {
  const lines: string[] = [];

  lines.push(`Target network: ${input.chainLabel ?? "studionet"}`);
  if (input.address) {
    lines.push(`Contract address: ${input.address}`);
  }
  if (input.contractPath) {
    lines.push(`Contract path: ${input.contractPath}`);
  }
  lines.push("");
  lines.push(formatContractInterface(input.schema));
  lines.push("");
  lines.push("Recommended workflow:");
  lines.push("1. Verify node connectivity with `genlayer_network_status`.");

  if (input.contractPath) {
    lines.push("2. Deploy through GenLayerJS `client.deployContract(...)` or your existing deploy script.");
    lines.push("3. Wait for `ACCEPTED` or `FINALIZED` using `genlayer_wait_for_transaction`.");
  } else {
    lines.push("2. Snapshot deployed contract state with `genlayer_get_contract_snapshot`.");
  }

  if (input.schema.viewMethods.length > 0) {
    lines.push(`4. Start read flows with \`${input.schema.viewMethods[0]?.name}\` using GenLayerJS \`readContract\` or MCP \`genlayer_call_contract\`.`);
  }
  if (input.schema.writeMethods.length > 0) {
    lines.push(`5. For state changes, use \`${input.schema.writeMethods[0]?.name}\` via GenLayerJS \`writeContract\`, then inspect status and receipt.`);
  }

  lines.push("6. If a transaction stalls or behaves unexpectedly, use `genlayer_inspect_transaction` and `genlayer_explain_transaction_status`.");
  lines.push("7. If your endpoint exposes debug methods, use `genlayer_trace_transaction` for execution-level diagnosis.");

  return lines.join("\n");
}

export function buildExecutionPlan(input: {
  action: "deploy" | "read" | "write";
  address?: string;
  args: unknown[];
  chainLabel?: string;
  contractPath?: string;
  from?: string;
  methodName?: string;
  schema: ContractInterfaceSummary;
  statusTarget?: "accepted" | "finalized";
  value?: string;
}): ContractExecutionPlan {
  const parameterSource = resolveParameterSource(input.action, input.methodName, input.schema);
  const validation = validateArguments(parameterSource.params, input.args);

  return {
    action: input.action,
    args: input.args,
    payable: parameterSource.payable,
    callMode: input.action === "deploy" ? "genlayer-js" : "gen_call",
    validation,
    ...(input.address ? { address: input.address } : {}),
    ...(input.chainLabel ? { chainLabel: input.chainLabel } : {}),
    ...(input.contractPath ? { contractPath: input.contractPath } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.methodName ? { methodName: input.methodName } : {}),
    ...(input.statusTarget ? { statusTarget: input.statusTarget } : {}),
    ...(input.value ? { value: input.value } : {})
  };
}

export function formatExecutionPlan(plan: ContractExecutionPlan): string {
  const lines: string[] = [];

  lines.push(`Action: ${plan.action}`);
  if (plan.methodName) {
    lines.push(`Method: ${plan.methodName}`);
  }
  if (plan.address) {
    lines.push(`Address: ${plan.address}`);
  }
  if (plan.contractPath) {
    lines.push(`Contract path: ${plan.contractPath}`);
  }
  if (plan.chainLabel) {
    lines.push(`Network: ${plan.chainLabel}`);
  }
  if (plan.from) {
    lines.push(`From: ${plan.from}`);
  }
  if (plan.value) {
    lines.push(`Value: ${plan.value}`);
  }
  if (plan.statusTarget) {
    lines.push(`Target status: ${plan.statusTarget}`);
  }
  lines.push(`Execution mode: ${plan.callMode}`);
  lines.push(`Payable: ${plan.payable ? "yes" : "no"}`);
  lines.push("");
  lines.push(`Validation: ${plan.validation.ok ? "ok" : "failed"}`);

  if (plan.validation.checks.length > 0) {
    for (const check of plan.validation.checks) {
      lines.push(`- ${check.name}: expected ${check.expectedType}, received ${check.receivedType}${check.ok ? "" : " [mismatch]"}`);
    }
  } else {
    lines.push("- no positional parameters");
  }

  if (plan.validation.problems.length > 0) {
    lines.push("");
    lines.push("Problems:");
    for (const problem of plan.validation.problems) {
      lines.push(`- ${problem}`);
    }
  }

  lines.push("");
  lines.push("Args JSON:");
  lines.push(JSON.stringify(plan.args, null, 2));

  return lines.join("\n");
}

export function buildWorkflowPlan(input: {
  address?: string;
  contractPath?: string;
  chainLabel?: string;
  schema: ContractInterfaceSummary;
}): ContractWorkflowPlan {
  const network = input.chainLabel ?? "custom";
  const firstView = input.schema.viewMethods[0]?.name ?? null;
  const firstWrite = input.schema.writeMethods[0]?.name ?? null;

  const phases: ContractWorkflowPlan["phases"] = [
    {
      name: "Connectivity",
      steps: [
        {
          name: "Check node status",
          tool: "genlayer_network_status",
          details: "Confirm health, chain id, block height, and sync state before contract work."
        }
      ]
    }
  ];

  if (input.contractPath) {
    phases.push({
      name: "Deployment",
      steps: [
        {
          name: "Generate deploy snippet",
          tool: "genlayer_generate_typescript_workflow",
          details: "Generate the GenLayerJS deploy code using the contract path and constructor schema."
        },
        {
          name: "Plan deploy args",
          tool: "genlayer_plan_contract_action",
          details: "Validate constructor args before sending the deployment transaction."
        },
        {
          name: "Wait for deployment",
          tool: "genlayer_wait_for_transaction",
          details: "Poll the deployment transaction until accepted or finalized."
        }
      ]
    });
  }

  phases.push({
    name: "Inspection",
    steps: [
      {
        name: "Snapshot contract",
        tool: "genlayer_get_contract_snapshot",
        details: "Fetch code, schema, and state together to verify the deployed contract surface."
      },
      {
        name: "Review interface",
        tool: "genlayer_get_contract_interface",
        details: "Normalize the schema into constructor, view, and write methods."
      }
    ]
  });

  const interactionSteps: ContractWorkflowStep[] = [];
  if (firstView) {
    interactionSteps.push({
      name: `Plan first read: ${firstView}`,
      tool: "genlayer_plan_contract_action",
      details: "Validate the first read call arguments before constructing the request."
    });
  }
  if (firstWrite) {
    interactionSteps.push({
      name: `Plan first write: ${firstWrite}`,
      tool: "genlayer_plan_contract_action",
      details: "Validate the first state-changing call and define the target confirmation status."
    });
    interactionSteps.push({
      name: "Monitor write transaction",
      tool: "genlayer_explain_transaction_status",
      details: "Interpret whether the write is still progressing, appealable, or finalized."
    });
  }
  if (interactionSteps.length > 0) {
    phases.push({
      name: "Interaction",
      steps: interactionSteps
    });
  }

  phases.push({
    name: "Diagnosis",
    steps: [
      {
        name: "Inspect transaction",
        tool: "genlayer_inspect_transaction",
        details: "Combine status, receipt, and Ethereum transaction lookup for debugging."
      },
      {
        name: "Trace transaction",
        tool: "genlayer_trace_transaction",
        details: "Use when the target node exposes debug trace methods."
      }
    ]
  });

  return {
    network,
    phases,
    recommendedReadMethod: firstView,
    recommendedWriteMethod: firstWrite,
    ...(input.contractPath ? { contractPath: input.contractPath } : {}),
    ...(input.address ? { targetAddress: input.address } : {})
  };
}

export function formatWorkflowPlan(plan: ContractWorkflowPlan): string {
  const lines: string[] = [];

  lines.push(`Network: ${plan.network}`);
  if (plan.targetAddress) {
    lines.push(`Contract address: ${plan.targetAddress}`);
  }
  if (plan.contractPath) {
    lines.push(`Contract path: ${plan.contractPath}`);
  }
  if (plan.recommendedReadMethod) {
    lines.push(`Recommended first read: ${plan.recommendedReadMethod}`);
  }
  if (plan.recommendedWriteMethod) {
    lines.push(`Recommended first write: ${plan.recommendedWriteMethod}`);
  }
  lines.push("");

  for (const phase of plan.phases) {
    lines.push(`${phase.name}:`);
    for (const step of phase.steps) {
      lines.push(`- ${step.name} | ${step.tool}`);
      lines.push(`  ${step.details}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function normalizeMethod(name: string, method: RawSchemaMethod | undefined): NormalizedContractMethod | undefined {
  if (!method) {
    return undefined;
  }

  return {
    name,
    kind: method.readonly ? "view" : "write",
    params: normalizeParams(method.params),
    kwparams: Object.keys(isRecord(method.kwparams) ? method.kwparams : {}),
    payable: Boolean(method.payable),
    returns: typeof method.ret === "string" ? method.ret : null
  };
}

function resolveParameterSource(
  action: "deploy" | "read" | "write",
  methodName: string | undefined,
  schema: ContractInterfaceSummary
): { params: ContractParameter[]; payable: boolean } {
  if (action === "deploy") {
    return {
      params: schema.constructorParams,
      payable: false
    };
  }

  const method = schema.methods.find((item) => item.name === methodName);
  if (!method) {
    throw new Error(`Unknown contract method "${methodName ?? "undefined"}".`);
  }

  if (action === "read" && method.kind !== "view") {
    throw new Error(`Method "${method.name}" is not a view method.`);
  }

  if (action === "write" && method.kind !== "write") {
    throw new Error(`Method "${method.name}" is not a write method.`);
  }

  return {
    params: method.params,
    payable: method.payable
  };
}

function validateArguments(expected: ContractParameter[], received: unknown[]): ContractExecutionPlan["validation"] {
  const checks = expected.map((parameter, index) => {
    const value = received[index];
    return {
      name: parameter.name,
      expectedType: parameter.type,
      received: value,
      receivedType: describeValueType(value),
      ok: valueMatchesType(value, parameter.type)
    };
  });

  const problems: string[] = [];

  if (received.length < expected.length) {
    problems.push(`Expected ${expected.length} positional arguments but received ${received.length}.`);
  }
  if (received.length > expected.length) {
    problems.push(`Received ${received.length} positional arguments but the schema declares ${expected.length}.`);
  }
  for (const check of checks) {
    if (!check.ok) {
      problems.push(`Argument "${check.name}" expected ${check.expectedType} but received ${check.receivedType}.`);
    }
  }

  return {
    checks,
    ok: problems.length === 0,
    problems
  };
}

function normalizeParams(value: unknown): ContractParameter[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return undefined;
      }

      const [name, type] = entry;
      if (typeof name !== "string" || typeof type !== "string") {
        return undefined;
      }

      return { name, type };
    })
    .filter((entry): entry is ContractParameter => Boolean(entry));
}

function formatMethodSignature(method: NormalizedContractMethod): string {
  const params = method.params.map((param) => `${param.name}: ${param.type}`).join(", ");
  const returnType = method.returns ?? "unknown";
  return `${method.name}(${params}) -> ${returnType}`;
}

function exampleArgsArray(params: ContractParameter[]): string {
  if (params.length === 0) {
    return "[]";
  }

  return `[${params.map((param) => exampleValueForType(param.type)).join(", ")}]`;
}

function exampleValueForType(type: string): string {
  const normalized = type.toLowerCase();

  if (normalized.includes("str") || normalized.includes("string") || normalized.includes("address")) {
    return "'example'";
  }
  if (normalized.includes("bool")) {
    return "true";
  }
  if (normalized.includes("int") || normalized.includes("u256") || normalized.includes("float")) {
    return "0";
  }
  if (normalized.includes("list") || normalized.includes("array")) {
    return "[]";
  }
  if (normalized.includes("map") || normalized.includes("dict")) {
    return "{}";
  }

  return "null";
}

function valueMatchesType(value: unknown, expectedType: string): boolean {
  const normalized = expectedType.toLowerCase();

  if (value === null || value === undefined) {
    return false;
  }
  if (normalized.includes("str") || normalized.includes("string") || normalized.includes("address")) {
    return typeof value === "string";
  }
  if (normalized.includes("bool")) {
    return typeof value === "boolean";
  }
  if (normalized.includes("int") || normalized.includes("u256") || normalized.includes("float")) {
    return typeof value === "number" || typeof value === "bigint";
  }
  if (normalized.includes("list") || normalized.includes("array")) {
    return Array.isArray(value);
  }
  if (normalized.includes("map") || normalized.includes("dict")) {
    return isRecord(value);
  }

  return true;
}

function describeValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
