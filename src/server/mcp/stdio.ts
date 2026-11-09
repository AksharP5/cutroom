import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

const baseUrl = process.env.CUTROOM_URL ?? "http://127.0.0.1:4317";
const server = createMcpServer({ baseUrl });
await server.connect(new StdioServerTransport());
