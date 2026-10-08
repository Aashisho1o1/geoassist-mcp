#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./tools.js";

// stdio is all Claude Desktop needs. Logs go to stderr so they never mix
// with the protocol messages on stdout.
await buildServer().connect(new StdioServerTransport());
console.error("geoassist-hazard-proximity MCP server running on stdio");
