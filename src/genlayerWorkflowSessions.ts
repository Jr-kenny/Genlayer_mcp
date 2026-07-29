import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface WorkflowSessionStep {
  details: string;
  name: string;
  status: "pending" | "completed";
  tool: string;
}

export interface WorkflowSessionPhase {
  name: string;
  steps: WorkflowSessionStep[];
}

export interface WorkflowSession {
  address?: string;
  completedSteps: number;
  contractPath?: string;
  createdAt: string;
  goal: "deploy" | "read" | "write" | "debug" | "onboard";
  id: string;
  network: string;
  notes?: string;
  phases: WorkflowSessionPhase[];
  totalSteps: number;
  updatedAt: string;
}

export class WorkflowSessionStore {
  private readonly baseDir: string;

  constructor(
    baseDir = path.join(process.cwd(), ".cache", "genlayer-workflow-sessions"),
    tenantId?: string
  ) {
    this.baseDir = tenantId
      ? path.join(baseDir, tenantDirectoryName(tenantId))
      : baseDir;
  }

  async create(input: {
    address?: string;
    contractPath?: string;
    goal: WorkflowSession["goal"];
    network: string;
    notes?: string;
    phases: WorkflowSessionPhase[];
  }): Promise<WorkflowSession> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const session: WorkflowSession = {
      id,
      goal: input.goal,
      network: input.network,
      createdAt: now,
      updatedAt: now,
      totalSteps: countSteps(input.phases),
      completedSteps: countCompletedSteps(input.phases),
      phases: input.phases,
      ...(input.address ? { address: input.address } : {}),
      ...(input.contractPath ? { contractPath: input.contractPath } : {}),
      ...(input.notes ? { notes: input.notes } : {})
    };

    await this.write(session);
    return session;
  }

  async get(id: string): Promise<WorkflowSession | undefined> {
    try {
      const text = await fs.readFile(this.filePath(id), "utf8");
      return JSON.parse(text) as WorkflowSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async updateStep(input: {
    completed: boolean;
    id: string;
    phaseIndex: number;
    stepIndex: number;
  }): Promise<WorkflowSession> {
    const session = await this.get(input.id);
    if (!session) {
      throw new Error(`Unknown workflow session "${input.id}".`);
    }

    const phase = session.phases[input.phaseIndex];
    const step = phase?.steps[input.stepIndex];
    if (!phase || !step) {
      throw new Error("Invalid phaseIndex or stepIndex.");
    }

    step.status = input.completed ? "completed" : "pending";
    session.completedSteps = countCompletedSteps(session.phases);
    session.totalSteps = countSteps(session.phases);
    session.updatedAt = new Date().toISOString();
    await this.write(session);
    return session;
  }

  async list(limit = 20): Promise<WorkflowSession[]> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const entries = await fs.readdir(this.baseDir);
    const sessions = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .slice(0, limit)
        .map(async (name) => {
          const text = await fs.readFile(path.join(this.baseDir, name), "utf8");
          return JSON.parse(text) as WorkflowSession;
        })
    );

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async write(session: WorkflowSession): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.filePath(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  private filePath(id: string): string {
    if (!isWorkflowSessionId(id)) {
      throw new Error("Invalid workflow session id.");
    }
    return path.join(this.baseDir, `${id}.json`);
  }
}

export function workflowPlanToSessionPhases(plan: { phases: Array<{ name: string; steps: Array<{ details: string; name: string; tool: string }> }> }): WorkflowSessionPhase[] {
  return plan.phases.map((phase) => ({
    name: phase.name,
    steps: phase.steps.map((step) => ({
      ...step,
      status: "pending"
    }))
  }));
}

export function formatWorkflowSession(session: WorkflowSession): string {
  const lines = [
    `Session: ${session.id}`,
    `Goal: ${session.goal}`,
    `Network: ${session.network}`,
    `Progress: ${session.completedSteps}/${session.totalSteps}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`
  ];

  if (session.address) {
    lines.push(`Address: ${session.address}`);
  }
  if (session.contractPath) {
    lines.push(`Contract path: ${session.contractPath}`);
  }
  if (session.notes) {
    lines.push(`Notes: ${session.notes}`);
  }

  lines.push("");
  session.phases.forEach((phase, phaseIndex) => {
    lines.push(`${phaseIndex + 1}. ${phase.name}`);
    phase.steps.forEach((step, stepIndex) => {
      lines.push(`   [${step.status === "completed" ? "x" : " "}] ${phaseIndex}.${stepIndex} ${step.name} | ${step.tool}`);
      lines.push(`   ${step.details}`);
    });
  });

  return lines.join("\n");
}

function countSteps(phases: WorkflowSessionPhase[]): number {
  return phases.reduce((sum, phase) => sum + phase.steps.length, 0);
}

function countCompletedSteps(phases: WorkflowSessionPhase[]): number {
  return phases.reduce((sum, phase) => sum + phase.steps.filter((step) => step.status === "completed").length, 0);
}

function isWorkflowSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function tenantDirectoryName(tenantId: string): string {
  return crypto.createHash("sha256").update(tenantId).digest("hex");
}
