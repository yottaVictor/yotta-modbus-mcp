/**
 * Yotta Modbus MCP Server — MVP
 * 
 * 透過 Antigravity AI Agent 控制 A-1869（8 DO）
 * 
 * MCP 工具：
 *   - read_do_status : 讀取全部 DO 狀態
 *   - write_do       : 請求控制單個 DO（回傳 confirm_token）
 *   - batch_write_do : 請求批量控制 DO（回傳 confirm_token）
 *   - confirm_action : 使用 token 確認執行寫入
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import ModbusRTU from 'modbus-serial';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

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

const { device, token: tokenConfig } = config;

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
// Token 管理（confirm_token 機制）
// ============================================================
const pendingActions = new Map();

/**
 * 產生 confirm_token 並儲存待執行的操作
 */
function createToken(action) {
    const token = `tk_${crypto.randomBytes(6).toString('hex')}`;
    const expiresAt = Date.now() + tokenConfig.expirySeconds * 1000;

    pendingActions.set(token, {
        action,
        expiresAt,
        createdAt: Date.now()
    });

    // 設定自動過期清理
    setTimeout(() => {
        pendingActions.delete(token);
    }, tokenConfig.expirySeconds * 1000);

    return { token, expiresIn: tokenConfig.expirySeconds };
}

/**
 * 驗證並取出 token 對應的操作
 */
function consumeToken(token) {
    const entry = pendingActions.get(token);

    if (!entry) {
        throw new Error('無效的 confirm_token（可能已過期或已使用）');
    }

    if (Date.now() > entry.expiresAt) {
        pendingActions.delete(token);
        throw new Error('confirm_token 已過期，請重新操作');
    }

    // 一次性使用，取出後刪除
    pendingActions.delete(token);
    return entry.action;
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
    `請求控制 ${device.name} 的單個 DO 通道。不會立即執行，會回傳 confirm_token。【重要】取得 token 後，必須將操作內容呈現給使用者，並等待使用者明確下達確認指令（例如「確認」、「執行」、「好」）後，才能呼叫 confirm_action。嚴禁自動連續呼叫 confirm_action，必須有使用者明確同意。`,
    {
        channel: z.number().int().min(0).max(device.doCount - 1).describe(`DO 通道編號（0~${device.doCount - 1}）`),
        value: z.number().int().min(0).max(1).describe('0=關閉, 1=開啟')
    },
    async ({ channel, value }) => {
        try {
            // 先讀取目前狀態
            const statuses = await readDoStatus();
            const currentValue = statuses[channel] ? 1 : 0;
            const actionText = value === 1 ? '開啟' : '關閉';

            // 如果目前狀態與目標相同
            if (currentValue === value) {
                return {
                    content: [{
                        type: 'text',
                        text: `ℹ️ DO${channel} 目前已經是 ${actionText} 狀態，無需操作。`
                    }]
                };
            }

            // 產生 token
            const { token, expiresIn } = createToken({
                type: 'write_do',
                channel,
                value
            });

            const text = [
                `⚠️ 即將${actionText} DO${channel}`,
                ``,
                `設備：${device.name}（${device.ip}）`,
                `通道：DO${channel}（Coil Address ${device.doBaseAddress + channel}）`,
                `目前狀態：${currentValue === 1 ? 'ON' : 'OFF'} → 將變為 ${value === 1 ? 'ON' : 'OFF'}`,
                ``,
                `confirm_token: ${token}`,
                `有效期限：${expiresIn} 秒`,
                ``,
                `請確認後呼叫 confirm_action 工具執行。`
            ].join('\n');

            return { content: [{ type: 'text', text }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 3：batch_write_do ---
server.tool(
    'batch_write_do',
    `請求批量控制 ${device.name} 的多個 DO 通道。不會立即執行，會回傳 confirm_token。【重要】取得 token 後，必須將所有操作的變更預覽呈現給使用者，並等待使用者明確下達確認指令（例如「確認」、「執行」、「好」）後，才能呼叫 confirm_action。嚴禁自動連續呼叫 confirm_action，必須有使用者明確同意。`,
    {
        operations: z.array(z.object({
            channel: z.number().int().min(0).max(device.doCount - 1).describe('DO 通道編號'),
            value: z.number().int().min(0).max(1).describe('0=關閉, 1=開啟')
        })).min(1).describe('批量操作清單')
    },
    async ({ operations }) => {
        try {
            // 先讀取目前狀態
            const statuses = await readDoStatus();

            // 產生 token
            const { token, expiresIn } = createToken({
                type: 'batch_write_do',
                operations
            });

            const changeLines = operations.map(op => {
                const current = statuses[op.channel] ? 'ON' : 'OFF';
                const target = op.value === 1 ? 'ON' : 'OFF';
                const action = op.value === 1 ? '開啟' : '關閉';
                return `  DO${op.channel}: ${current} → ${target}（${action}）`;
            });

            const text = [
                `⚠️ 即將批量操作 ${operations.length} 個 DO 通道`,
                ``,
                `設備：${device.name}（${device.ip}）`,
                `變更預覽：`,
                ...changeLines,
                ``,
                `confirm_token: ${token}`,
                `有效期限：${expiresIn} 秒`,
                ``,
                `請確認後呼叫 confirm_action 工具執行。`
            ].join('\n');

            return { content: [{ type: 'text', text }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 4：confirm_action ---
server.tool(
    'confirm_action',
    `使用 confirm_token 確認並執行先前請求的寫入操作。Token 為一次性使用，${tokenConfig.expirySeconds} 秒後過期。`,
    {
        token: z.string().describe('由 write_do 或 batch_write_do 回傳的 confirm_token')
    },
    async ({ token }) => {
        try {
            const action = consumeToken(token);

            if (action.type === 'write_do') {
                await writeSingleDo(action.channel, action.value);
                const actionText = action.value === 1 ? '開啟' : '關閉';
                return {
                    content: [{
                        type: 'text',
                        text: `✅ DO${action.channel} 已${actionText}`
                    }]
                };
            }

            if (action.type === 'batch_write_do') {
                await writeMultipleDo(action.operations);
                const details = action.operations
                    .map(op => `DO${op.channel} → ${op.value === 1 ? 'ON' : 'OFF'}`)
                    .join(', ');
                return {
                    content: [{
                        type: 'text',
                        text: `✅ 批量操作完成：${details}`
                    }]
                };
            }

            return {
                content: [{ type: 'text', text: '❌ 未知的操作類型' }],
                isError: true
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
