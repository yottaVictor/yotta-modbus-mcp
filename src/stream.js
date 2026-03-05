/**
 * Yotta Modbus MCP Server — Streamable HTTP 入口
 * 供 Node-RED / 網頁應用使用
 *
 * 啟動方式：node src/stream.js
 * Node-RED 連接網址：http://localhost:3002/mcp
 */

import express from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

const PORT = process.env.PORT || 3002;

const app = express();
app.use(cors());
app.use(express.json());

// 每個請求建立獨立的 McpServer + Transport（Stateless 模式）
// 與 node-red-contrib-mcp 完全相容
app.all('/mcp', async (req, res) => {
    console.error(`[MCP] ${req.method} /mcp`);

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined   // Stateless：不需 session 管理
    });

    transport.onclose = () => {
        server.close().catch(() => { });
    };

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('[MCP] 處理失敗:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

app.listen(PORT, () => {
    console.error('\n======================================================');
    console.error('[MCP Server] Streamable HTTP 模式已啟動');
    console.error(`▶ Node-RED 連接網址：http://localhost:${PORT}/mcp`);
    console.error('======================================================\n');
});

process.on('SIGINT', () => { console.error('\n[MCP] 關閉中...'); process.exit(0); });
process.on('SIGTERM', () => { console.error('\n[MCP] 關閉中...'); process.exit(0); });
