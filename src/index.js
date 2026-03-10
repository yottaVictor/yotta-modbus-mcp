/**
 * Yotta Modbus MCP Server — stdio 入口
 * 供 Antigravity / Claude / OpenCLAW 使用
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
