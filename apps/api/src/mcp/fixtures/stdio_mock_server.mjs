import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "hermetic-stdio-mock", version: "1.0.0" });

server.registerTool(
  "ping",
  {
    description: "Ping pong test tool",
    inputSchema: { message: z.string().optional() },
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async ({ message }) => {
    return {
      content: [{ type: "text", text: `pong: ${message ?? "ok"}` }],
    };
  },
);

server.registerTool(
  "crash",
  {
    description: "Crashes the server process intentionally",
    inputSchema: {},
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async () => {
    setTimeout(() => {
      process.exit(1);
    }, 10);
    return {
      content: [{ type: "text", text: "crashing" }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
