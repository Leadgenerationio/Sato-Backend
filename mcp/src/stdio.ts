#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStatoMcpServer } from './server.js';
import { StatoApi } from './stato-client.js';
import { apiUrl, requiredEnv } from './config.js';

// Local use (Claude Desktop / Claude Code): the client launches this process
// and talks over stdin/stdout. Config: STATO_API_URL + STATO_API_KEY.
const server = createStatoMcpServer(new StatoApi({ baseUrl: apiUrl(), apiKey: requiredEnv('STATO_API_KEY') }));
await server.connect(new StdioServerTransport());
