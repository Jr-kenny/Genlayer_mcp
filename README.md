# GenLayer MCP

[![npm](https://img.shields.io/npm/v/genskill-mcp.svg)](https://www.npmjs.com/package/genskill-mcp)
[![CI](https://github.com/Jr-kenny/genskill-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Jr-kenny/genskill-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a.svg)](package.json)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-server-7c5cff.svg)](https://modelcontextprotocol.io)

An MCP server that combines searchable GenLayer documentation with live GenLayer protocol RPC inspection for MCP-compatible clients like Claude Code, Cursor, VS Code, Gemini CLI, Codex, and remote MCP clients over HTTP.

This project does not sign transactions or manage private keys. It supports live node inspection and contract interaction through GenLayer JSON-RPC methods such as `gen_call`, `gen_getContractState`, `gen_getContractCode`, `gen_getContractSchema`, `gen_getTransactionStatus`, and `gen_getTransactionReceipt`.

## Install

| Use | Command / URL |
| --- | --- |
| Local (stdio) | `npx -y genskill-mcp` |
| Hosted (remote) | `https://genlayer-mcp.vercel.app/mcp` |

Per-client setup (Claude Code, Cursor, VS Code, Gemini, Codex, remote) is in the quickstarts below.

## What this server does

The server loads the official GenLayer docs bundle:

- [https://docs.genlayer.com/full-documentation.txt](https://docs.genlayer.com/full-documentation.txt)

It parses that bundle into sections and exposes:

- searchable MCP tools
- a browsable docs index resource
- individual section resources
- live GenLayer JSON-RPC tools for contract and transaction inspection
- a browsable RPC configuration resource
- contract authoring tools: scaffold a starter contract and lint it before deploy
- guided MCP prompts for writing, testing, and debugging contracts

This repository supports two transports:

- `stdio` for local CLI tools such as Claude Code, Codex, Cursor, VS Code, and Gemini CLI
- Streamable HTTP for deployed remote MCP usage

## Build a contract (authoring tools, new in 2.2)

If you are new to GenLayer, this is the fast path from zero to a deployable
contract. It does not just point you at docs, it gives you working code and
checks it.

- **`genlayer_scaffold_contract`** generates a working starter Intelligent
  Contract for a template (`storage`, `llm-judge`, `web-oracle`, `token`). The
  output already has the runner header pinned and avoids the common GenVM
  deploy-killers, so it deploys as-is.
- **`genlayer_lint_contract`** runs static pre-deploy checks on contract source.
  It catches the mistakes that make a deploy finalize with a bare
  `invalid_contract` (no stack trace): a comment line directly under the runner
  header, an unpinned or `:test` / `:latest` runner, a missing `gl.Contract`
  class, forbidden sandbox imports (`os`, `sys`, `subprocess`, `random`, ...),
  and GenVM Python-subset issues such as `for` loops, `sorted`, `.sort`,
  `lambda`, and `list` / `dict` storage fields.
- **`genlayer_scaffold_test`** generates a fast direct-mode test
  (`genlayer-test`) for a template, using the real fixtures (`direct_vm`,
  `direct_deploy`, `direct_alice`) and mocking web/LLM calls so tests stay
  deterministic.

Three guided prompts wrap the workflow for any MCP client:

- **`genlayer_write_contract`** scaffold, decide what needs consensus, then lint.
- **`genlayer_test_contract`** direct-mode then integration testing.
- **`genlayer_debug_deploy`** the checklist for a deploy that errored on-chain.

And a single always-available resource, **`genlayer://guide/contract-rules`**, is
an authoritative cheat sheet (skeleton, storage types, web/LLM/equivalence APIs,
the GenVM Python-subset rules, and the deploy/finalize/debug checklist) that any
connecting agent can read to get contract writing and debugging right. It tracks
the latest GenLayer docs and the official write-contract / direct-tests skills.

Typical loop: scaffold, edit, `genlayer_lint_contract` until it is clean, deploy,
then inspect it live with `genlayer_get_contract_snapshot`.

## RPC configuration

Live protocol tools use the configured GenLayer RPC endpoint.

- `GENLAYER_RPC_URL`: JSON-RPC endpoint to use
- `GENLAYER_RPC_TIMEOUT_MS`: timeout for live RPC requests

If `GENLAYER_RPC_URL` is not set, the server defaults to:

```text
https://studio.genlayer.com/api
```

## Quickstart for Claude Code

```bash
claude mcp add --transport stdio genskill -- npx -y genskill-mcp
```

Then start Claude Code:

```bash
claude
```

Inside Claude Code, run:

```bash
/mcp
```

The `genskill` server and its tool endpoints should be listed.

## Quickstart for Cursor (per-project)

Add this to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "genskill": {
      "command": "npx",
      "args": ["-y", "genskill-mcp"]
    }
  }
}
```

> [!TIP]
> If a Cursor version does not recognize `mcpServers`, use `mcp_servers` as the top-level key instead.

## Quickstart for VS Code (per-workspace)

Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "genskill": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "genskill-mcp"]
    }
  },
  "inputs": []
}
```

## Quickstart for Gemini CLI

Add the MCP server globally:

```bash
gemini mcp add --scope user genskill npx -y genskill-mcp
```

Confirm it is registered:

```bash
gemini mcp list
```

## Quickstart for Codex

Add the MCP server with the Codex CLI:

```bash
codex mcp add genskill -- npx -y genskill-mcp
```

Confirm it is registered:

```bash
codex mcp list
```

Alternatively, add this to a Codex MCP config:

```toml
[mcp_servers.genskill]
command = "npx"
args = ["-y", "genskill-mcp"]
```

Restart Codex if needed so it reloads the MCP config.

## Quickstart from source

For source-based usage instead of installing from npm:

1. Clone the repo:

   ```bash
   git clone https://github.com/Jr-kenny/genskill-mcp
   cd genskill-mcp
   ```

2. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

3. Run the local entrypoint:

   ```bash
   node /absolute/path/to/genskill-mcp/dist/cli.js
   ```

Substitute that `node .../dist/cli.js` command in any MCP client config for source-based usage over `npx`.

## Quickstart for remote MCP clients

For remote MCP clients, run the HTTP entrypoint and deploy it as a public web service.

This is not Claude-specific. It is the deployed transport for any client that can connect to remote MCP servers over Streamable HTTP, including chat-style AI apps where that capability is available.

1. Deploy this repository to Vercel.

2. The deployed MCP endpoint is:

   ```text
   https://genlayer-mcp.vercel.app/mcp
   ```

3. The deployed service also exposes:

   - `GET /` for a small server info response
   - `GET /health` for health checks
   - `POST /mcp` for MCP Streamable HTTP requests

4. Add the deployed MCP URL in a remote MCP client as an HTTP MCP server.

Use:

```text
https://genlayer-mcp.vercel.app/mcp
```

This applies to Claude-hosted integrations, ChatGPT-style apps, and other remote AI clients where MCP server URLs are supported.

For local HTTP testing, run:

   ```bash
   npm install
   npm run build
   npm run start:http
   ```

It listens on port `3000` by default. Set the `PORT` environment variable to change it.

## Vercel deployment

This repository is configured for Vercel through `vercel.json` and the Web-standard API functions in `api/`.

Public MCP endpoint on Vercel:

```text
https://genlayer-mcp.vercel.app/mcp
```

Useful checks:

- `https://genlayer-mcp.vercel.app/`
- `https://genlayer-mcp.vercel.app/health`
- `POST https://genlayer-mcp.vercel.app/mcp` from an MCP client

Notes:

- `/mcp` is routed to the Vercel function at `/api/mcp.mjs`.
- The Vercel endpoint uses the MCP SDK Web-standard Streamable HTTP transport in stateless mode.
- POST requests return JSON responses where possible, which is friendlier for serverless hosting than holding long SSE streams open.
- If the docs update while the service is already deployed, call `genlayer_refresh_docs` from an MCP client or redeploy the project.

## Tool endpoints

High-level orchestration tools now use a canonical machine-readable response shape with:
- `kind`
- `summary`
- `current_state`
- `blockers`
- `next_actions`
- `fallbacks`
- `data`

The autopilot and capability surfaces are capability-aware: they should prefer only actions supported by the currently configured endpoint and explicitly downgrade unsupported debug or ops paths into fallbacks.

### Live protocol tools

1. `genlayer_list_networks`
   Lists documented GenLayer network presets, chain IDs, and RPC URLs.

2. `genlayer_start_workflow_session`
   Creates a persisted workflow session from a generated contract workflow plan.

3. `genlayer_list_workflow_sessions`
   Lists persisted workflow sessions ordered by most recently updated.

4. `genlayer_get_workflow_session`
   Reads a persisted workflow session by id.

5. `genlayer_update_workflow_step`
   Marks a workflow session step as completed or pending.

6. `genlayer_autopilot_brief`
   Generates a single operator-grade brief with endpoint capabilities, contract context, workflow plans, handoff steps, and relevant docs.

7. `genlayer_load_contract_artifact`
   Loads a local contract artifact or bytecode file and returns base64 plus file metadata.

8. `genlayer_probe_endpoint_capabilities`
   Probes which HTTP and RPC surfaces are actually exposed on the configured GenLayer deployment.

9. `genlayer_generate_agent_handoff`
   Generates an explicit ordered handoff bundle so weaker agents know exactly which GenLayer MCP tools to call next.

10. `genlayer_get_contract_interface`
   Normalizes a contract schema into constructor, view methods, and write methods.

11. `genlayer_plan_contract_action`
   Builds a schema-validated execution plan for deploy, read, or write actions.

12. `genlayer_plan_contract_workflow`
   Builds a multi-phase contract workflow covering deploy, wait, snapshot, interaction, and diagnosis.

13. `genlayer_run_transaction_report`
   Orchestrates waiting, inspection, status explanation, optional trace lookup, and optional contract snapshot into one report.

14. `genlayer_run_contract_report`
   Orchestrates network context, contract snapshot, interface, workflow, and default plans into one report.

15. `genlayer_generate_typescript_workflow`
   Generates GenLayerJS deploy/read/write snippets from a contract schema or deployed contract.

16. `genlayer_generate_contract_playbook`
   Generates a schema-aware deployment and interaction playbook for a contract.

17. `genlayer_node_health`
   Calls the configured GenLayer node HTTP `GET /health` endpoint.

18. `genlayer_network_status`
   Returns a combined live snapshot of node health, chain id, block height, sync status, and optional debug ping status.

19. `genlayer_balance`
   Calls the configured GenLayer HTTP `GET /balance` endpoint for the node operator.

20. `genlayer_eth_get_balance`
   Calls `eth_getBalance` through the configured GenLayer RPC endpoint.

21. `genlayer_raw_rpc`
   Calls `gen_*`, `eth_*`, `zks_*`, or `zksync_*` methods directly against the configured endpoint.

22. `genlayer_trace_transaction`
   Calls `gen_dbg_traceTransaction` when the target node exposes debug methods.

23. `genlayer_metrics`
   Fetches Prometheus-style metrics from the configured HTTP `GET /metrics` endpoint.

24. `genlayer_submit_raw_transaction`
   Submits a signed raw transaction through `eth_sendRawTransaction`.

25. `genlayer_inspect_transaction`
   Combines `gen_getTransactionStatus`, `gen_getTransactionReceipt`, and `eth_getTransactionByHash` into one response.

26. `genlayer_wait_for_transaction`
   Polls transaction status until `accepted` or `finalized`.

27. `genlayer_explain_transaction_status`
   Interprets transaction status into finality phase, appealability, and next-step guidance.

28. `genlayer_call_contract`
   Executes `gen_call` for read, write-simulation, or deploy-simulation requests.

29. `genlayer_get_contract_schema`
   Calls `gen_getContractSchema` for base64-encoded contract code.

30. `genlayer_get_contract_state`
   Calls `gen_getContractState` for a deployed contract.

31. `genlayer_get_contract_code`
   Calls `gen_getContractCode` for a deployed contract.

32. `genlayer_get_contract_snapshot`
   Fetches state, deployed code, and derived schema in one call.

33. `genlayer_get_transaction_status`
   Calls `gen_getTransactionStatus` for lightweight transaction polling.

34. `genlayer_get_transaction_receipt`
   Calls `gen_getTransactionReceipt` for full processed transaction data.

35. `genlayer_syncing`
    Calls `gen_syncing` on the configured endpoint.

### Documentation tools

36. `genlayer_search_docs`
   Searches the documentation bundle and returns ranked matches with snippets.

37. `genlayer_refresh_docs`
   Force-refreshes the cached GenLayer documentation bundle from the configured source. Use this after the GenLayer team ships new docs, for example new Studio GEN, payable contract, Faucet, Tip Jar, or MetaMask updates.

38. `genlayer_read_doc`
   Reads a section by slug, path, title, or fuzzy query.

39. `genlayer_get_doc_by_slug`
   Reads a section by exact slug, path, docs URL, or resource URI.

40. `genlayer_search_examples`
   Searches example-heavy sections that contain commands, code blocks, SDK snippets, or config examples.

41. `genlayer_get_related_docs`
   Finds related documentation pages based on section path, title, and neighborhood in the docs tree.

42. `genlayer_list_topics`
   Lists top-level GenLayer documentation topics with counts and example pages.

43. `genlayer_list_sections`
   Lists available parsed documentation sections.

## Resources

1. `genlayer://protocol/networks`
   Documented GenLayer network presets, RPC URLs, and chain IDs.

2. `genlayer://workflow/sessions`
   List of persisted workflow sessions.

3. `genlayer://workflow/session/{id}`
   Persisted workflow session with step completion state.

4. `genlayer://workflow/autopilot`
   Single operator-grade brief for the configured endpoint and current contract context.

5. `genlayer://protocol/rpc-config`
   JSON document showing the configured RPC endpoint, timeout, and supported helper methods.

6. `genlayer://protocol/capabilities`
   Probed endpoint capabilities showing which HTTP and RPC surfaces are actually exposed.

7. `genlayer://protocol/transaction/{txId}`
   Combined transaction inspection resource for a specific transaction hash.

8. `genlayer://protocol/transaction/{txId}/report`
   Composed transaction report with status interpretation and optional trace data when exposed.

9. `genlayer://protocol/contract/{address}/state`
   Current accepted-state snapshot for a specific deployed contract.

10. `genlayer://protocol/contract/{address}/snapshot`
   Combined state, code, and schema snapshot for a specific deployed contract.

11. `genlayer://protocol/contract/{address}/playbook`
   Schema-aware deployment and interaction playbook for a deployed contract.

12. `genlayer://protocol/contract/{address}/report`
   Composed contract report with network context, snapshot, interface, workflow, and default plans.

13. `genlayer://protocol/contract/{address}/plans`
   Default workflow plus default read/write action plans for a deployed contract.

14. `genlayer://protocol/contract/{address}/method/{method}/plan/{action}`
   Default schema-validated plan for a specific read or write method.

15. `genlayer://docs/index`
   JSON index of all parsed sections.

16. `genlayer://docs/section/{slug}`
   Individual documentation sections as read-only resources.

## Project structure

| File/Folder | Purpose |
| --- | --- |
| `src/index.ts` | The server logic: loads docs, parses sections, registers tools and resources |
| `src/cli.ts` | Entry point that starts the stdio MCP server |
| `src/genlayerAuthoring.ts` | Contract scaffolder + linter + test scaffolder (pure, unit-tested) |
| `src/authoringTools.ts` | Registers the authoring tools and the dev-workflow prompts |
| `src/mcpResponses.ts` | Shared canonical response envelope helpers |
| `src/genlayerDocs.ts` | Docs loading, caching, parsing, search, and formatting helpers |
| `src/genlayerRpc.ts` | GenLayer RPC, HTTP ops endpoints, network presets, and transaction helpers |
| `src/genlayerContractToolkit.ts` | Schema normalization and GenLayerJS workflow/playbook generation |
| `src/genlayerArtifacts.ts` | Local artifact loading and hashing for artifact-driven GenLayer workflows |
| `src/genlayerWorkflowSessions.ts` | Persisted workflow session state and session formatting helpers |
| `api/` | Vercel API functions for the remote MCP, health, and root endpoints |
| `test/` | Unit tests for the authoring module (`npm test`, built-in node:test) |
| `dist/` | Compiled JavaScript output generated by `npm run build` |
| `package.json` | Dependencies, scripts, package metadata, and CLI registration |
| `tsconfig.json` | TypeScript compiler settings |
| `vercel.json` | Vercel routing and function configuration |
| `README.md` | Usage and client setup |

## How it's built

This MCP server is a lightweight TypeScript implementation built on the official MCP SDK.

### Core components

- Built on [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- Uses `StdioServerTransport` for local MCP clients
- Uses `zod` to validate tool arguments
- Fetches the GenLayer docs bundle from the official docs site
- Parses the bundle into section-level resources based on each `# path/to/file.mdx` boundary
- Uses a simple deterministic ranking function over titles, slugs, paths, and body text

## Configuration

Optional environment variables:

- `GENLAYER_DOCS_URL`: alternate source URL or local file path for the docs bundle
- `GENLAYER_DOCS_CACHE_FILE`: cache location for the downloaded bundle
- `GENLAYER_DOCS_REFRESH_HOURS`: cache freshness window in hours, default `24`
- `GENLAYER_DOCS_TIMEOUT_MS`: HTTP timeout in milliseconds, default `15000`

The server also refreshes stale in-memory snapshots automatically. For long-running HTTP deployments, call `genlayer_refresh_docs` when the GenLayer team ships new documentation and an immediate update is needed without restarting the service.

## Local development

This section is only for working on the MCP server itself.

```bash
npm install
npm run build
npm run check
npm start
```

`npm run check` verifies that the server can fetch and parse the live GenLayer docs bundle.

## Releasing (maintainers)

Releases are published to npm automatically by `.github/workflows/release.yml`
when a `v*` tag is pushed. One-time setup: add an npm automation token as the
`NPM_TOKEN` repository secret (`gh secret set NPM_TOKEN`).

To cut a release:

```bash
npm version minor        # bumps package.json, commits, creates the tag vX.Y.Z
git push --follow-tags   # pushes the commit + tag; CI builds, tests, publishes
```

The workflow checks the tag matches `package.json`, runs the tests, and publishes
with npm provenance. Once published, consumers update with:

```bash
npx -y genskill-mcp@latest      # always newest
npm update -g genskill-mcp      # if installed globally
```

Remote (Vercel) users need no action — the hosted endpoint auto-deploys from
`main`; clients pick up changes on reconnect.

## Credits

Built and maintained by:

- [Jr-kenny](https://github.com/Jr-kenny)
- [Prime isles](https://github.com/Prime-isles)
