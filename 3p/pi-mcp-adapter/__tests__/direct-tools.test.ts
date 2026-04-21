import { describe, expect, it } from "vitest";
import { buildProxyDescription, resolveDirectTools } from "../direct-tools.js";
import { computeServerHash, type MetadataCache } from "../metadata-cache.js";
import { buildToolMetadata } from "../tool-metadata.js";
import type { McpConfig } from "../types.js";
import { reconstructToolMetadata } from "../metadata-cache.js";

describe("buildProxyDescription", () => {
  it("documents the ui-messages action", () => {
    const config: McpConfig = {
      mcpServers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        demo: {
          configHash: "hash",
          cachedAt: Date.now(),
          tools: [
            {
              name: "launch_app",
              description: "Launch the demo app",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          resources: [],
        },
      },
    };

    const description = buildProxyDescription(config, cache, []);

    expect(description).toContain('mcp({ action: "ui-messages" })');
    expect(description).toContain("Retrieve accumulated messages from completed UI sessions");
  });

  it("excludes configured tools from proxy summaries", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          excludeTools: ["get_figjam", "figma_get_screenshot"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Take screenshot" },
            { name: "get_nodes", description: "Get nodes" },
          ],
          resources: [
            { name: "figjam", uri: "ui://figjam", description: "FigJam" },
          ],
        },
      },
    };

    const description = buildProxyDescription(config, cache, []);

    expect(description).toContain("Servers: figma (1 tools)");
    expect(description).not.toContain("figma (3 tools)");
  });
});

describe("excludeTools filtering", () => {
  it("filters excluded tools from live and cached metadata", () => {
    const definition = {
      command: "npx",
      args: ["-y", "figma"],
      excludeTools: ["figma_get_screenshot", "get_figjam"],
    };

    const { metadata } = buildToolMetadata(
      [
        { name: "get_screenshot", description: "Screenshot" },
        { name: "get_nodes", description: "Nodes" },
      ] as any,
      [
        { name: "figjam", uri: "ui://figjam", description: "FigJam" },
      ] as any,
      definition,
      "figma",
      "server",
    );

    expect(metadata.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);

    const reconstructed = reconstructToolMetadata(
      "figma",
      {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [
          { name: "get_screenshot", description: "Screenshot" },
          { name: "get_nodes", description: "Nodes" },
        ],
        resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
      },
      "server",
      definition,
    );

    expect(reconstructed.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);
  });

  it("filters excluded tools during direct tool registration from cache", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot", "get_figjam"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [
            { name: "figjam", uri: "ui://figjam", description: "FigJam" },
          ],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "server");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["figma_get_nodes"]);
  });

  it("matches prefixed exclusions even when toolPrefix is none", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "none" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "none");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["get_nodes"]);
  });
});
