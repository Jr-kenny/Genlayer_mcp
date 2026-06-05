import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONTRACT_TEMPLATES,
  type ContractTemplate,
  lintContractSource,
  scaffoldContract,
  scaffoldTest
} from "./genlayerAuthoring.js";
import { makeCanonicalResponse, textEnvelope } from "./mcpResponses.js";

export function registerAuthoring(server: McpServer): void {
  const templateNames = Object.keys(CONTRACT_TEMPLATES) as [ContractTemplate, ...ContractTemplate[]];

  server.registerTool(
    "genlayer_scaffold_contract",
    {
      title: "Scaffold Intelligent Contract",
      description:
        "Generate a working starter GenLayer intelligent contract for a chosen template. " +
        "The output has the runner header pinned and avoids the common deploy-killers.",
      inputSchema: {
        template: z.enum(templateNames).describe(
          "storage | llm-judge | web-oracle | token"
        ),
        name: z.string().optional().describe("Optional contract name (becomes the class name).")
      },
      annotations: { title: "Scaffold Intelligent Contract", readOnlyHint: true, idempotentHint: true }
    },
    async ({ template, name }) => {
      const result = scaffoldContract(template as ContractTemplate, name);
      return textEnvelope(
        makeCanonicalResponse({
          kind: "contract_scaffold",
          summary: `Scaffolded a ${template} contract (${result.className}).`,
          currentState: { template, className: result.className },
          blockers: [],
          nextActions: result.nextSteps,
          fallbacks: ["Run `genlayer_lint_contract` on the output before deploying."],
          data: { template, className: result.className, description: result.summary, code: result.code }
        })
      );
    }
  );

  server.registerTool(
    "genlayer_lint_contract",
    {
      title: "Lint Intelligent Contract",
      description:
        "Static pre-deploy checks for a GenLayer contract. Catches the mistakes that make a " +
        "deploy finalize with a bare `invalid_contract` or fail consensus: a comment directly " +
        "under the runner header, unpinned/alias runners, missing gl.Contract, and GenVM " +
        "Python-subset issues (for/sorted/lambda) and storage anti-patterns.",
      inputSchema: {
        code: z.string().describe("Full contract source to lint.")
      },
      annotations: { title: "Lint Intelligent Contract", readOnlyHint: true, idempotentHint: true }
    },
    async ({ code }) => {
      const result = lintContractSource(code);
      const fmt = (level: string) =>
        result.findings
          .filter((f) => f.level === level)
          .map((f) => `${f.line ? `L${f.line}` : "-"} [${f.rule}] ${f.message}${f.hint ? ` (fix: ${f.hint})` : ""}`);
      return textEnvelope(
        makeCanonicalResponse({
          kind: "contract_lint",
          summary: result.ok
            ? `No blocking errors. ${result.warnings} warning(s), ${result.infos} info.`
            : `${result.errors} error(s) would likely break deploy. ${result.warnings} warning(s).`,
          currentState: { ok: result.ok, errors: result.errors, warnings: result.warnings, infos: result.infos },
          blockers: fmt("error"),
          nextActions: result.ok
            ? ["Looks deployable. Test in direct mode, then deploy and wait for FINALIZED before reading."]
            : ["Fix the errors above, then lint again before spending a deploy."],
          fallbacks: [...fmt("warning"), ...fmt("info")],
          data: { result }
        })
      );
    }
  );

  server.registerTool(
    "genlayer_scaffold_test",
    {
      title: "Scaffold Direct-Mode Test",
      description:
        "Generate a fast in-memory direct-mode test (genlayer-test) for a contract template. " +
        "Uses the real fixtures (direct_vm, direct_deploy, direct_alice) and mocks web/LLM calls.",
      inputSchema: {
        template: z.enum(templateNames).describe("storage | llm-judge | web-oracle | token"),
        name: z.string().optional().describe("Contract class name the test targets.")
      },
      annotations: { title: "Scaffold Direct-Mode Test", readOnlyHint: true, idempotentHint: true }
    },
    async ({ template, name }) => {
      const result = scaffoldTest(template as ContractTemplate, name);
      return textEnvelope(
        makeCanonicalResponse({
          kind: "test_scaffold",
          summary: `Scaffolded a direct-mode test for the ${template} template.`,
          currentState: { template, className: result.className, path: result.path },
          blockers: [],
          nextActions: result.nextSteps,
          fallbacks: ["Mocks (mock_web/mock_llm) keep tests deterministic; clear them with direct_vm.clear_mocks()."],
          data: { template, path: result.path, code: result.code }
        })
      );
    }
  );

  // ── Prompts: one-click GenLayer dev workflows for any MCP client ──
  server.registerPrompt(
    "genlayer_write_contract",
    {
      title: "Write a GenLayer intelligent contract",
      description: "Guided workflow to author a contract that passes consensus and deploys cleanly.",
      argsSchema: { idea: z.string().optional().describe("What the contract should do.") }
    },
    ({ idea }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Help me write a GenLayer intelligent contract${idea ? ` for: ${idea}` : ""}.\n\n` +
              "Follow this workflow:\n" +
              "1. Start from `genlayer_scaffold_contract` (pick storage / llm-judge / web-oracle / token) so the runner header and structure are correct.\n" +
              "2. Decide what truly needs validator consensus. Only the subjective/external/AI judgment goes through an equivalence principle; everything else is plain deterministic code.\n" +
              "3. Storage: class-level annotations with GenLayer types (u256, Address, DynArray[T], TreeMap[K,V]); never `list`/`dict`/plain `int`; set values (not types) in __init__.\n" +
              "4. For LLM/web calls use a custom validator with `gl.vm.run_nondet_unsafe`; agree on a stable derived field (a band, a verdict), never on raw free text.\n" +
              "5. Use `while` loops, not `for`; avoid `sorted`/`.sort`/`lambda`.\n" +
              "6. Before deploying, run `genlayer_lint_contract` on the result and fix every error.\n\n" +
              "Search `genlayer_search_docs` for any API you are unsure about."
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "genlayer_test_contract",
    {
      title: "Test a GenLayer contract",
      description: "Direct-mode and integration testing workflow before and after deploy.",
      argsSchema: { code: z.string().optional().describe("Contract source under test.") }
    },
    ({ code }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Help me test this GenLayer contract.\n\n" +
              "1. Lint first with `genlayer_lint_contract` to rule out deploy-killers.\n" +
              "2. Generate a starting test with `genlayer_scaffold_test`, then expand it.\n\n" +
              "Direct mode (fast, in-memory, ~30-50ms, no Docker):\n" +
              "- Install: `pip install genlayer-test`; run: `pytest tests/direct/ -v`\n" +
              "- Fixtures: `direct_vm`, `direct_deploy`, `direct_alice` / `direct_bob` / `direct_owner`.\n" +
              "- Deterministic mocks: `direct_vm.mock_web(regex, {\"status\":200,\"body\":...})` and `direct_vm.mock_llm(regex, response)`; reset with `direct_vm.clear_mocks()`.\n" +
              "- Cheatcodes: `direct_vm.sender = alice`, `with direct_vm.expect_revert(\"msg\")`, `with direct_vm.prank(bob)`, `direct_vm.warp(...)`.\n\n" +
              "Integration mode (full leader+validator consensus, after direct passes):\n" +
              "- Install: `pip install genlayer-test[sim]` (or `genlayer up` for Docker Studio).\n" +
              "- Run: `gltest tests/integration/ -v -s --network localnet` (or studionet / testnet_bradbury).\n" +
              "- Pattern: `get_contract_factory(\"Name\").deploy(args=[])`, then `contract.method(args=[...]).transact()` for writes and `.call()` for reads; assert with `tx_execution_succeeded(receipt)`.\n\n" +
              "After deploy, verify live with `genlayer_get_contract_snapshot`; reads need the contract FINALIZED, not just accepted.\n" +
              (code ? `\nContract under test:\n\n\`\`\`python\n${code}\n\`\`\`` : "")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "genlayer_debug_deploy",
    {
      title: "Debug a failed GenLayer deploy",
      description: "Checklist for a deploy that finalized but errored (invalid_contract / contract_error).",
      argsSchema: { code: z.string().optional().describe("The contract that failed to deploy.") }
    },
    ({ code }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "My GenLayer deploy finalized but the contract errored (e.g. `invalid_contract`) with no stack trace. Walk this checklist:\n\n" +
              "1. Run `genlayer_lint_contract` on the source first.\n" +
              "2. Runner header: is the FIRST line a pinned `# { \"Depends\": \"py-genlayer:<hash>\" }`? No `:test`/`:latest`/unpinned.\n" +
              "3. THE classic silent killer: is there a comment line directly under the runner header? Move all comments below the imports.\n" +
              "4. Read the NESTED result, not just the top-level status: `consensus_data.leader_receipt[0].execution_result`. A finalized tx can still have errored construction.\n" +
              "5. GenVM Python subset: replace `for` loops with `while`; remove `sorted`/`.sort`/`lambda`.\n" +
              "6. Storage: class-level annotations only; GenLayer types, not `list`/`dict`/plain `int`.\n" +
              "7. Reads failing with 'Contract not found' right after deploy usually just means it is not FINALIZED yet, not a bad address.\n" +
              (code ? `\nContract:\n\n\`\`\`python\n${code}\n\`\`\`` : "")
          }
        }
      ]
    })
  );
}
