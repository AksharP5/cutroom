import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { importSocketPath, requestMediaImport } from "../../local/mediaImport";
import { AGENT_HEADER, AGENT_NAME_HEADER } from "../../shared/review";
import { externalHistoryCredential } from "../projects/historyActor";
import { createMcpServer, localApiBase } from "./server";

const baseUrl = localApiBase(process.env.CUTROOM_URL);
const agentToken =
  process.env.CUTROOM_AGENT_TOKEN ?? externalHistoryCredential();
const server = createMcpServer({
  baseUrl,
  agentToken,
  importMedia: (projectId, paths, signal, name, progress) =>
    requestMediaImport(importSocketPath(baseUrl), projectId, paths, {
      signal,
      headers: {
        [AGENT_HEADER]: agentToken,
        [AGENT_NAME_HEADER]: encodeURIComponent(name),
      },
      progress: ({ copied, total }) => progress(copied, total),
    }),
});
await server.connect(new StdioServerTransport());
