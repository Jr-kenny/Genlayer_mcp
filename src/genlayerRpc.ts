const DEFAULT_RPC_URL = "https://studio.genlayer.com/api";
const DEFAULT_TIMEOUT_MS = 15000;

type JsonRpcId = number;

export interface RpcServiceOptions {
  rpcUrl?: string;
  timeoutMs?: number;
}

export interface GenlayerCallRequest {
  from: string;
  to?: string;
  data: string;
  type: "read" | "write" | "deploy";
  blockNumber?: string;
  status?: "accepted" | "finalized";
  value?: string;
  leader_results?: string[] | null;
}

export interface ContractLookupRequest {
  address: string;
  blockNumber?: string;
  status?: "accepted" | "finalized";
}

export interface TransactionLookupRequest {
  txId: string;
  timestamp?: number;
}

export interface WaitForTransactionRequest extends TransactionLookupRequest {
  intervalMs?: number;
  maxAttempts?: number;
  targetStatus?: "accepted" | "finalized";
}

export interface TraceTransactionRequest {
  txID: string;
  round?: number;
}

export interface RpcSnapshot {
  endpoint: string;
  healthEndpoint: string;
  methods: string[];
  networkPresets: GenlayerNetworkPreset[];
  timeoutMs: number;
}

export interface TransactionInspection {
  receipt: unknown;
  rpcTransaction: unknown;
  status: unknown;
  txId: string;
}

export interface WaitForTransactionResult extends TransactionInspection {
  attempts: number;
  completed: boolean;
  matchedStatus: string | null;
  targetStatus: "accepted" | "finalized";
}

export interface GenlayerNetworkPreset {
  chainId: number;
  chainRpcUrl?: string;
  currency: string;
  explorerUrl?: string;
  faucetUrl?: string;
  kind: "hosted-dev" | "local" | "testnet" | "underlying-chain";
  label: string;
  rpcUrl: string;
}

export interface TransactionStatusInfo {
  code: number | null;
  finalityPhase: "pre-acceptance" | "appeal-window" | "final" | "unknown";
  isAppealable: boolean;
  isFinal: boolean;
  isSuccessfulTerminal: boolean;
  label: string | null;
}

const NETWORK_PRESETS: GenlayerNetworkPreset[] = [
  {
    label: "Studionet",
    kind: "hosted-dev",
    rpcUrl: "https://studio.genlayer.com/api",
    chainId: 61999,
    currency: "GEN",
    explorerUrl: "https://explorer-studio.genlayer.com"
  },
  {
    label: "Bradbury Testnet",
    kind: "testnet",
    rpcUrl: "https://rpc-bradbury.genlayer.com",
    chainRpcUrl: "https://rpc.testnet-chain.genlayer.com",
    chainId: 4221,
    currency: "GEN",
    explorerUrl: "https://explorer-bradbury.genlayer.com",
    faucetUrl: "https://testnet-faucet.genlayer.foundation"
  },
  {
    label: "Asimov Testnet",
    kind: "testnet",
    rpcUrl: "https://rpc-asimov.genlayer.com",
    chainRpcUrl: "https://rpc.testnet-chain.genlayer.com",
    chainId: 4221,
    currency: "GEN",
    explorerUrl: "https://explorer-asimov.genlayer.com",
    faucetUrl: "https://testnet-faucet.genlayer.foundation"
  },
  {
    label: "Localnet",
    kind: "local",
    rpcUrl: "http://localhost:4000/api",
    chainId: 61127,
    currency: "GEN",
    explorerUrl: "http://localhost:8080"
  },
  {
    label: "GenLayer Chain L2",
    kind: "underlying-chain",
    rpcUrl: "https://rpc.testnet-chain.genlayer.com",
    chainId: 4221,
    currency: "GEN",
    explorerUrl: "https://explorer.testnet-chain.genlayer.com"
  }
];

interface JsonRpcSuccess<T> {
  id: JsonRpcId | null;
  jsonrpc: "2.0";
  result: T;
}

interface JsonRpcFailure {
  id: JsonRpcId | null;
  jsonrpc: "2.0";
  error: {
    code: number;
    data?: unknown;
    message: string;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export class GenlayerRpcService {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private nextId: JsonRpcId;

  constructor(options: RpcServiceOptions = {}) {
    this.rpcUrl = options.rpcUrl ?? process.env.GENLAYER_RPC_URL ?? DEFAULT_RPC_URL;
    this.timeoutMs = options.timeoutMs ?? readNumber(process.env.GENLAYER_RPC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.nextId = 1;
  }

  getSnapshot(): RpcSnapshot {
    return {
      endpoint: this.rpcUrl,
      healthEndpoint: deriveOpsUrl(this.rpcUrl, "/health"),
      methods: [
        "balance",
        "eth_blockNumber",
        "eth_chainId",
        "eth_getBalance",
        "eth_getTransactionByHash",
        "eth_getTransactionReceipt",
        "eth_sendRawTransaction",
        "eth_syncing",
        "gen_call",
        "gen_dbg_ping",
        "gen_dbg_traceTransaction",
        "gen_getContractSchema",
        "gen_getContractState",
        "gen_getContractCode",
        "gen_getTransactionReceipt",
        "gen_getTransactionStatus",
        "gen_syncing"
      ],
      networkPresets: NETWORK_PRESETS,
      timeoutMs: this.timeoutMs
    };
  }

  async health(): Promise<unknown> {
    return this.readJson(deriveOpsUrl(this.rpcUrl, "/health"));
  }

  async balance(address: string): Promise<unknown> {
    void address;
    return this.readJson(deriveOpsUrl(this.rpcUrl, "/balance"));
  }

  async metrics(): Promise<string> {
    return this.readText(deriveOpsUrl(this.rpcUrl, "/metrics"), "text/plain");
  }

  async debugPing(): Promise<unknown> {
    return this.call("gen_dbg_ping", []);
  }

  async debugTraceTransaction(request: TraceTransactionRequest): Promise<unknown> {
    return this.call("gen_dbg_traceTransaction", [request]);
  }

  async genCall(request: GenlayerCallRequest): Promise<unknown> {
    return this.call("gen_call", [request]);
  }

  async getContractSchema(code: string): Promise<unknown> {
    return this.call("gen_getContractSchema", [{ code }]);
  }

  async getContractState(request: ContractLookupRequest): Promise<unknown> {
    return this.call("gen_getContractState", [request]);
  }

  async getContractCode(request: ContractLookupRequest): Promise<unknown> {
    return this.call("gen_getContractCode", [request]);
  }

  async getTransactionReceipt(request: TransactionLookupRequest): Promise<unknown> {
    return this.call("gen_getTransactionReceipt", [request]);
  }

  async getTransactionStatus(request: TransactionLookupRequest): Promise<unknown> {
    return this.call("gen_getTransactionStatus", [request]);
  }

  async syncing(): Promise<unknown> {
    try {
      return await this.call("gen_syncing", []);
    } catch {
      return this.call("eth_syncing", []);
    }
  }

  async chainId(): Promise<string> {
    return this.call("eth_chainId", []);
  }

  async blockNumber(): Promise<string> {
    return this.call("eth_blockNumber", []);
  }

  async getEthBalance(address: string, blockTag = "latest"): Promise<string> {
    return this.call("eth_getBalance", [address, blockTag]);
  }

  async getTransactionByHash(txId: string): Promise<unknown> {
    return this.call("eth_getTransactionByHash", [txId]);
  }

  async getEthTransactionReceipt(txId: string): Promise<unknown> {
    return this.call("eth_getTransactionReceipt", [txId]);
  }

  async sendRawTransaction(rawTransaction: string): Promise<string> {
    return this.call("eth_sendRawTransaction", [rawTransaction]);
  }

  async inspectTransaction(request: TransactionLookupRequest): Promise<TransactionInspection> {
    const [status, receipt, rpcTransaction] = await Promise.all([
      this.getTransactionStatus(request).catch((error) => ({
        error: error instanceof Error ? error.message : String(error)
      })),
      this.getTransactionReceipt(request).catch((error) => ({
        error: error instanceof Error ? error.message : String(error)
      })),
      this.getTransactionByHash(request.txId).catch((error) => ({
        error: error instanceof Error ? error.message : String(error)
      }))
    ]);

    return {
      txId: request.txId,
      status,
      receipt,
      rpcTransaction
    };
  }

  async contractSnapshot(request: ContractLookupRequest): Promise<{
    address: string;
    code: unknown;
    schema: unknown;
    state: unknown;
    status: "accepted" | "finalized" | null;
    blockNumber: string | null;
  }> {
    const code = await this.getContractCode(request);
    const statePromise = this.getContractState(request).catch((error) => ({
      error: error instanceof Error ? error.message : String(error)
    }));
    const schemaPromise = typeof code === "string"
      ? this.getContractSchema(code).catch((error) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
      : Promise.resolve({
          error: "Contract code response was not a base64 string."
        });

    const [state, schema] = await Promise.all([statePromise, schemaPromise]);

    return {
      address: request.address,
      blockNumber: request.blockNumber ?? null,
      status: request.status ?? null,
      code,
      schema,
      state
    };
  }

  async waitForTransaction(request: WaitForTransactionRequest): Promise<WaitForTransactionResult> {
    const intervalMs = request.intervalMs ?? 2500;
    const maxAttempts = request.maxAttempts ?? 24;
    const targetStatus = request.targetStatus ?? "finalized";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const inspection = await this.inspectTransaction(request);
      const matchedStatus = normalizeTransactionStatus(inspection.status);
      const completed = targetStatus === "accepted"
        ? matchedStatus === "accepted" || matchedStatus === "finalized"
        : matchedStatus === "finalized";

      if (completed) {
        return {
          ...inspection,
          attempts: attempt,
          completed: true,
          matchedStatus,
          targetStatus
        };
      }

      if (attempt < maxAttempts) {
        await sleep(intervalMs);
      }
    }

    const inspection = await this.inspectTransaction(request);
    return {
      ...inspection,
      attempts: maxAttempts,
      completed: false,
      matchedStatus: normalizeTransactionStatus(inspection.status),
      targetStatus
    };
  }

  async raw(method: string, params: unknown[] = []): Promise<unknown> {
    return this.call(method, params);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const requestId = this.nextId;
    this.nextId += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          id: requestId
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as JsonRpcResponse<T>;

      if ("error" in payload) {
        const details = payload.error.data === undefined ? "" : ` | data: ${safeJson(payload.error.data)}`;
        throw new Error(`${payload.error.message} (code ${payload.error.code})${details}`);
      }

      return payload.result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`GenLayer RPC request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson<T>(url: string): Promise<T> {
    const text = await this.readText(url, "application/json");

    if (looksLikeHtml(text)) {
      throw new Error(`Endpoint ${url} did not return JSON. This operation may not be exposed on the current GenLayer deployment.`);
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(
        `Endpoint ${url} returned a non-JSON response. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async readText(url: string, accept = "text/plain"): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: accept
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`GenLayer HTTP request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function formatJson(value: unknown): string {
  return safeJson(value);
}

export function buildRpcConfigDocument(snapshot: RpcSnapshot): string {
  return safeJson(snapshot);
}

export function buildNetworkPresetsDocument(): string {
  return safeJson(NETWORK_PRESETS);
}

export function listNetworkPresets(): GenlayerNetworkPreset[] {
  return NETWORK_PRESETS.slice();
}

export function interpretTransactionStatus(value: unknown): TransactionStatusInfo {
  const normalized = normalizeTransactionStatus(value);
  const code = extractStatusCode(value);

  switch (normalized) {
    case "pending":
    case "proposing":
    case "committing":
    case "revealing":
      return {
        label: normalized.toUpperCase(),
        code,
        isAppealable: false,
        isFinal: false,
        isSuccessfulTerminal: false,
        finalityPhase: "pre-acceptance"
      };
    case "accepted":
    case "ready_to_finalize":
    case "appeal_committing":
    case "appeal_revealing":
      return {
        label: normalized.toUpperCase(),
        code,
        isAppealable: true,
        isFinal: false,
        isSuccessfulTerminal: false,
        finalityPhase: "appeal-window"
      };
    case "finalized":
      return {
        label: normalized.toUpperCase(),
        code,
        isAppealable: false,
        isFinal: true,
        isSuccessfulTerminal: true,
        finalityPhase: "final"
      };
    case "canceled":
    case "undetermined":
    case "validators_timeout":
    case "leader_timeout":
    case "uninitialized":
      return {
        label: normalized.toUpperCase(),
        code,
        isAppealable: false,
        isFinal: normalized === "canceled" || normalized === "undetermined",
        isSuccessfulTerminal: false,
        finalityPhase: normalized === "canceled" || normalized === "undetermined" ? "final" : "unknown"
      };
    default:
      return {
        label: normalized ? normalized.toUpperCase() : null,
        code,
        isAppealable: false,
        isFinal: false,
        isSuccessfulTerminal: false,
        finalityPhase: "unknown"
      };
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function looksLikeHtml(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return normalized.startsWith("<!doctype html") || normalized.startsWith("<html");
}

function deriveOpsUrl(rpcUrl: string, suffix: "/balance" | "/health" | "/metrics"): string {
  const url = new URL(rpcUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (normalizedPath.endsWith("/api")) {
    url.pathname = `${normalizedPath.slice(0, -4) || ""}${suffix}`;
    return url.toString();
  }

  url.pathname = `${normalizedPath || ""}${suffix}`;
  return url.toString();
}

function normalizeTransactionStatus(value: unknown): string | null {
  if (typeof value === "string") {
    return value.toLowerCase();
  }

  if (value && typeof value === "object") {
    const statusField = (value as Record<string, unknown>).status;
    if (typeof statusField === "string") {
      return statusField.toLowerCase();
    }

    const resultField = (value as Record<string, unknown>).result;
    if (typeof resultField === "string") {
      return resultField.toLowerCase();
    }

    const nested = (value as Record<string, unknown>).data;
    if (nested && typeof nested === "object") {
      const nestedStatus = (nested as Record<string, unknown>).status;
      if (typeof nestedStatus === "string") {
        return nestedStatus.toLowerCase();
      }
    }
  }

  return null;
}

function extractStatusCode(value: unknown): number | null {
  if (value && typeof value === "object") {
    const direct = (value as Record<string, unknown>).statusCode;
    if (typeof direct === "number") {
      return direct;
    }

    const nested = (value as Record<string, unknown>).data;
    if (nested && typeof nested === "object") {
      const nestedCode = (nested as Record<string, unknown>).statusCode;
      if (typeof nestedCode === "number") {
        return nestedCode;
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
