#!/usr/bin/env node
/**
 * stdio <-> HTTP bridge to one agenda's council MCP endpoint.
 *
 * Antigravity CLI (agy) only reads MCP servers from its global config, so a Gemini chair cannot be
 * pointed at "its" agenda per run. The global config instead holds this bridge, and the agenda is
 * chosen by the env of the agy process that spawned it:
 *   GENCOUNCIL_COUNCIL_URL     http(s) URL of /mcp/<project>/<agenda>
 *   GENCOUNCIL_COUNCIL_TOKEN   bearer token for that URL
 * Without them (members, the user's own agy sessions) the bridge serves no tools.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const url = process.env.GENCOUNCIL_COUNCIL_URL;
const token = process.env.GENCOUNCIL_COUNCIL_TOKEN;

let upstream: Client | undefined;
async function client(): Promise<Client | undefined> {
  if (!url) return undefined;
  if (upstream) return upstream;
  const c = new Client({ name: "gencouncil-bridge", version: "0.1.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined));
  upstream = c;
  return c;
}

const server = new Server({ name: "gencouncil-council", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const c = await client();
  return c ? await c.listTools() : { tools: [] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const c = await client();
  if (!c) return { content: [{ type: "text", text: "council is not available in this session" }], isError: true };
  return await c.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} });
});

await server.connect(new StdioServerTransport());
