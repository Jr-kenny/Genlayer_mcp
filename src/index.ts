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

const service = new GenlayerDocsService();

export function createDocsServer(): McpServer {
  const server = new McpServer(
    {
      name: "genlayer-docs-mcp",
      version: "1.0.0",
      websiteUrl: "https://docs.genlayer.com/",
      description: "Read-only MCP server for GenLayer documentation search and retrieval."
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
