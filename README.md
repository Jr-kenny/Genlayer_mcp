# GenLayer docs MCP

A lightweight, docs-only MCP server that exposes GenLayer documentation as searchable tools and browsable resources for MCP-compatible clients like Claude Code, Cursor, VS Code, Gemini CLI, Codex, and remote MCP clients over HTTP.

This project is a read-only docs server. It does not talk to the GenLayer chain, sign transactions, or modify anything.

## What this server does

The server loads the official GenLayer docs bundle:

- [https://docs.genlayer.com/full-documentation.txt](https://docs.genlayer.com/full-documentation.txt)

It parses that bundle into sections and exposes:

- searchable MCP tools
- a browsable docs index resource
- individual section resources

This repository supports two transports:

- `stdio` for local CLI tools such as Claude Code, Codex, Cursor, VS Code, and Gemini CLI
- Streamable HTTP for deployed remote MCP usage

## Quickstart for Claude Code

```bash
claude mcp add --transport stdio genlayer-docs -- npx -y github:Jr-kenny/Genlayer_mcp
```

Then start Claude Code:

```bash
claude
```

Inside Claude Code, run:

```bash
/mcp
```

The `genlayer-docs` server and its tool endpoints should be listed.

## Quickstart for Cursor (per-project)

Add this to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "genlayer-docs": {
      "command": "npx",
      "args": ["-y", "github:Jr-kenny/Genlayer_mcp"]
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
    "genlayer-docs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:Jr-kenny/Genlayer_mcp"]
    }
  },
  "inputs": []
}
```

## Quickstart for Gemini CLI

Add the MCP server globally:

```bash
gemini mcp add --scope user genlayer-docs npx -y github:Jr-kenny/Genlayer_mcp
```

Confirm it is registered:

```bash
gemini mcp list
```

## Quickstart for Codex

Add the MCP server with the Codex CLI:

```bash
codex mcp add genlayer-docs -- npx -y github:Jr-kenny/Genlayer_mcp
```

Confirm it is registered:

```bash
codex mcp list
```

Alternatively, add this to a Codex MCP config:

```toml
[mcp_servers.genlayer-docs]
command = "npx"
args = ["-y", "github:Jr-kenny/Genlayer_mcp"]
```

Restart Codex if needed so it reloads the MCP config.

## Quickstart from source

For source-based usage instead of launching from GitHub:

1. Clone the repo:

   ```bash
   git clone https://github.com/Jr-kenny/Genlayer_mcp
   cd Genlayer_mcp
   ```

2. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

3. Run the local entrypoint:

   ```bash
   node /absolute/path/to/Genlayer_mcp/dist/cli.js
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

1. `genlayer_search_docs`
   Searches the documentation bundle and returns ranked matches with snippets.

2. `genlayer_refresh_docs`
   Force-refreshes the cached GenLayer documentation bundle from the configured source. Use this after the GenLayer team ships new docs, for example new Studio GEN, payable contract, Faucet, Tip Jar, or MetaMask updates.

3. `genlayer_read_doc`
   Reads a section by slug, path, title, or fuzzy query.

4. `genlayer_get_doc_by_slug`
   Reads a section by exact slug, path, docs URL, or resource URI.

5. `genlayer_search_examples`
   Searches example-heavy sections that contain commands, code blocks, SDK snippets, or config examples.

6. `genlayer_get_related_docs`
   Finds related documentation pages based on section path, title, and neighborhood in the docs tree.

7. `genlayer_list_topics`
   Lists top-level GenLayer documentation topics with counts and example pages.

8. `genlayer_list_sections`
   Lists available parsed documentation sections.

## Resources

1. `genlayer://docs/index`
   JSON index of all parsed sections.

2. `genlayer://docs/section/{slug}`
   Individual documentation sections as read-only resources.

## Project structure

| File/Folder | Purpose |
| --- | --- |
| `src/index.ts` | The server logic: loads docs, parses sections, registers tools and resources |
| `src/cli.ts` | Entry point that starts the stdio MCP server |
| `src/genlayerDocs.ts` | Docs loading, caching, parsing, search, and formatting helpers |
| `api/` | Vercel API functions for the remote MCP, health, and root endpoints |
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
