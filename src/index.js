/**
 * Yotta Modbus MCP Server — MVP
 * 
 * 透過 Antigravity AI Agent 控制 A-1869（8 DO）
 * 
 * MCP 工具：
 *   - read_do_status : 讀取全部 DO 狀態
 *   - write_do       : 直接控制單個 DO
 *   - batch_write_do : 直接批量控制 DO
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import ModbusRTU from 'modbus-serial';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ============================================================
// 全域鎖 (Mutex) - 防止並發連線衝突
// ============================================================
let connectionMutex = Promise.resolve();

async function withLock(fn) {
    const prevMutex = connectionMutex;
    let resolveNext;
    connectionMutex = new Promise(resolve => { resolveNext = resolve; });
    try {
        await prevMutex;
        return await fn();
    } finally {
        resolveNext();
    }
}

// ============================================================
// 載入設定
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const { device } = config;

// ============================================================
// Modbus TCP 連線管理
// 策略：每次操作建立獨立連線，完成後立即關閉（connect-use-disconnect）
// 原因：避免跨 MCP 工具呼叫之間的連線閒置超時，導致殭屍連線無法恢復
// ============================================================

/**
 * 建立臨時連線、執行操作、然後關閉
 * @param {Function} fn - 接收 client 參數的非同步操作函式
 */
async function withModbus(fn) {
    return await withLock(async () => {
        const client = new ModbusRTU();
        console.error(`[Modbus] 正在連線到 ${device.ip}:${device.port}...`);
        try {
            await client.connectTCP(device.ip, { port: device.port });
            client.setID(device.slaveId);
            client.setTimeout(5000);
            console.error(`[Modbus] 連線成功！ (Slave ID: ${device.slaveId})`);
            return await fn(client);
        } catch (err) {
            console.error(`[Modbus] 操作失敗: ${err.message}`);
            throw err;
        } finally {
            // 強制銷毀底層 TCP socket，確保不留殘存連線
            // 注意：client.close(callback) 不保證執行 callback，改用底層 destroy
            try {
                if (client._port && client._port.destroy) {
                    client._port.destroy();
                } else if (client.isOpen) {
                    await new Promise(resolve => client.close(resolve));
                }
                console.error(`[Modbus] 連線已關閉`);
            } catch (closeErr) {
                console.error(`[Modbus] 關閉連線時發生錯誤（忽略）: ${closeErr.message}`);
            }
        }
    });
}

/**
 * 讀取 DO 狀態（FC01 Read Coils）
 * @returns {Array<boolean>} 各 DO 通道狀態
 */
async function readDoStatus() {
    try {
        return await withModbus(async (client) => {
            const result = await client.readCoils(device.doBaseAddress, device.doCount);
            return result.data;
        });
    } catch (err) {
        throw new Error(`讀取 DO 狀態失敗：${err.message}`);
    }
}

/**
 * 寫入單個 DO（FC05 Write Single Coil）
 */
async function writeSingleDo(channel, value) {
    try {
        await withModbus(async (client) => {
            const address = device.doBaseAddress + channel;
            await client.writeCoil(address, value === 1);
        });
    } catch (err) {
        throw new Error(`寫入 DO${channel} 失敗：${err.message}`);
    }
}

/**
 * 寫入多個 DO（FC15 Write Multiple Coils）
 */
async function writeMultipleDo(operations) {
    try {
        await withModbus(async (client) => {
            // 在同一條連線內先讀再寫，減少額外的連線次數
            const result = await client.readCoils(device.doBaseAddress, device.doCount);
            const newValues = [...result.data];
            for (const op of operations) {
                newValues[op.channel] = op.value === 1;
            }
            await client.writeCoils(device.doBaseAddress, newValues);
        });
    } catch (err) {
        throw new Error(`批量寫入 DO 失敗：${err.message}`);
    }
}

// ============================================================
// 格式化輸出
// ============================================================
function formatDoStatus(statuses) {
    const lines = statuses.map((val, i) => `DO${i}: ${val ? 'ON 🟢' : 'OFF ⚫'}`);
    return lines.join('\n');
}

// ============================================================
// MCP Server 設定
// ============================================================
const server = new McpServer({
    name: 'yotta-modbus',
    version: '1.0.0'
});

// --- 工具 1：read_do_status ---
server.tool(
    'read_do_status',
    `讀取 ${device.name}（${device.ip}）全部 ${device.doCount} 個 DO 通道的即時狀態。`,
    {},
    async () => {
        try {
            const statuses = await readDoStatus();
            const text = `📡 ${device.name}（${device.ip}）DO 狀態：\n\n${formatDoStatus(statuses)}`;
            return { content: [{ type: 'text', text }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 2：write_do ---
server.tool(
    'write_do',
    `控制 ${device.name} 的單個 DO 通道，立即執行。`,
    {
        channel: z.number().int().min(0).max(device.doCount - 1).describe(`DO 通道編號（0~${device.doCount - 1}）`),
        value: z.number().int().min(0).max(1).describe('0=關閉, 1=開啟')
    },
    async ({ channel, value }) => {
        try {
            const actionText = value === 1 ? '開啟' : '關閉';
            await writeSingleDo(channel, value);
            return {
                content: [{
                    type: 'text',
                    text: `✅ DO${channel} 已${actionText}`
                }]
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 3：batch_write_do ---
server.tool(
    'batch_write_do',
    `批量控制 ${device.name} 的多個 DO 通道，立即執行。`,
    {
        operations: z.array(z.object({
            channel: z.number().int().min(0).max(device.doCount - 1).describe('DO 通道編號'),
            value: z.number().int().min(0).max(1).describe('0=關閉, 1=開啟')
        })).min(1).describe('批量操作清單')
    },
    async ({ operations }) => {
        try {
            await writeMultipleDo(operations);
            const details = operations
                .map(op => `DO${op.channel} → ${op.value === 1 ? 'ON' : 'OFF'}`)
                .join(', ');
            return {
                content: [{
                    type: 'text',
                    text: `✅ 批量操作完成：${details}`
                }]
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// ============================================================
// 啟動 MCP Server
// ============================================================
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // MCP Server 已透過 stdio 啟動，等待 Antigravity 連線
}

main().catch((err) => {
    console.error('MCP Server 啟動失敗：', err);
    process.exit(1);
});

// ============================================================
// 安全關閉處理
// ============================================================
async function cleanup() {
    console.error('\n[MCP] 正在關閉 MCP Server...');
    // connect-use-disconnect 模式下每次操作後連線已自動關閉，無需額外清理
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGHUP', cleanup);
