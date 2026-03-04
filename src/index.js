/**
 * Yotta Modbus MCP Server — 多設備全 I/O 版
 * 
 * 支援 DO / DI / AI / AO 的多台設備控制
 * 
 * MCP 工具：
 *   - list_devices    : 列出所有設備
 *   - read_do_status  : 讀取 DO 數位輸出狀態（FC01）
 *   - write_do        : 寫入單個 DO（FC05）
 *   - batch_write_do  : 批量寫入多個 DO（FC15）
 *   - read_di_status  : 讀取 DI 數位輸入狀態（FC02）
 *   - read_ai_values  : 讀取 AI 類比輸入數值（FC04）
 *   - read_ao_values  : 讀取 AO 類比輸出目前值（FC03）
 *   - write_ao        : 寫入單個 AO（FC06）
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

/** @type {Map<string, object>} 設備 ID → 設備設定 */
const deviceMap = new Map(config.devices.map(d => [d.id, d]));

/** 所有設備的簡介字串（用於工具說明） */
const deviceIdList = config.devices
    .map(d => `"${d.id}"（${d.name} ${d.ip}）`)
    .join('、');

/**
 * 根據 deviceId 取得設備設定，找不到則拋出錯誤
 */
function getDevice(deviceId) {
    const device = deviceMap.get(deviceId);
    if (!device) {
        const validIds = [...deviceMap.keys()].join(', ');
        throw new Error(`找不到設備 "${deviceId}"，有效 ID：${validIds}`);
    }
    return device;
}

/**
 * 確認設備具備指定的 I/O 類型，否則拋出說明性錯誤
 */
function requireIO(device, ioType) {
    if (!device[ioType]) {
        throw new Error(`設備 "${device.id}"（${device.name}）不具備 ${ioType.toUpperCase()} 通道`);
    }
    return device[ioType];
}

// ============================================================
// Modbus TCP 連線管理
// 策略：每次操作建立獨立連線，完成後立即關閉（connect-use-disconnect）
// ============================================================

/**
 * 建立臨時連線、執行操作、然後關閉
 * @param {object} device - 設備設定物件
 * @param {Function} fn   - 接收 client 參數的非同步操作函式
 */
async function withModbus(device, fn) {
    return await withLock(async () => {
        const client = new ModbusRTU();
        console.error(`[Modbus] 正在連線到 ${device.name}（${device.ip}:${device.port}）...`);
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

// ============================================================
// Modbus 操作函式
// ============================================================

/** FC01 - 讀取 DO (Coils) */
async function readDoStatus(device) {
    const io = requireIO(device, 'do');
    return await withModbus(device, async (client) => {
        const result = await client.readCoils(io.baseAddress, io.count);
        return result.data.slice(0, io.count);
    });
}

/** FC05 - 寫入單個 DO (Single Coil) */
async function writeSingleDo(device, channel, value) {
    const io = requireIO(device, 'do');
    if (channel >= io.count) {
        throw new Error(`DO${channel} 超出範圍，${device.name} 最多 DO${io.count - 1}`);
    }
    await withModbus(device, async (client) => {
        await client.writeCoil(io.baseAddress + channel, value === 1);
    });
}

/** FC15 - 批量寫入 DO (Multiple Coils) */
async function writeMultipleDo(device, operations) {
    const io = requireIO(device, 'do');
    await withModbus(device, async (client) => {
        const result = await client.readCoils(io.baseAddress, io.count);
        const newValues = [...result.data];
        for (const op of operations) {
            newValues[op.channel] = op.value === 1;
        }
        await client.writeCoils(io.baseAddress, newValues);
    });
}

/** FC02 - 讀取 DI (Discrete Inputs) */
async function readDiStatus(device) {
    const io = requireIO(device, 'di');
    return await withModbus(device, async (client) => {
        const result = await client.readDiscreteInputs(io.baseAddress, io.count);
        return result.data.slice(0, io.count);
    });
}

/** FC04 - 讀取 AI (Input Registers) */
async function readAiValues(device) {
    const io = requireIO(device, 'ai');
    return await withModbus(device, async (client) => {
        const result = await client.readInputRegisters(io.baseAddress, io.count);
        return result.data.slice(0, io.count);
    });
}

/** FC03 - 讀取 AO (Holding Registers) */
async function readAoValues(device) {
    const io = requireIO(device, 'ao');
    return await withModbus(device, async (client) => {
        const result = await client.readHoldingRegisters(io.baseAddress, io.count);
        return result.data.slice(0, io.count);
    });
}

/** FC06 - 寫入單個 AO (Single Holding Register) */
async function writeAo(device, channel, value) {
    const io = requireIO(device, 'ao');
    if (channel >= io.count) {
        throw new Error(`AO${channel} 超出範圍，${device.name} 最多 AO${io.count - 1}`);
    }
    await withModbus(device, async (client) => {
        await client.writeRegister(io.baseAddress + channel, value);
    });
}

// ============================================================
// 格式化輸出
// ============================================================
function fmtDo(device, statuses) {
    return [`📡 ${device.name}（${device.ip}）DO 狀態：`,
        '', ...statuses.map((v, i) => `DO${i}: ${v ? 'ON 🟢' : 'OFF ⚫'}`)].join('\n');
}

function fmtDi(device, statuses) {
    return [`📥 ${device.name}（${device.ip}）DI 狀態：`,
        '', ...statuses.map((v, i) => `DI${i}: ${v ? 'ON 🟢' : 'OFF ⚫'}`)].join('\n');
}

function fmtAi(device, values) {
    return [`📊 ${device.name}（${device.ip}）AI 數值：`,
        '', ...values.map((v, i) => `AI${i}: ${v}`)].join('\n');
}

function fmtAo(device, values) {
    return [`📤 ${device.name}（${device.ip}）AO 數值：`,
        '', ...values.map((v, i) => `AO${i}: ${v}`)].join('\n');
}

// ============================================================
// MCP Server 設定
// ============================================================
const server = new McpServer({
    name: 'yotta-modbus',
    version: '3.0.0'
});

const deviceIdDesc = `設備 ID，可用：${[...deviceMap.keys()].join('、')}`;

// --- 工具 1：list_devices ---
server.tool(
    'list_devices',
    '列出所有可控制的 Modbus 設備及其 ID 與 I/O 配置。',
    {},
    async () => {
        const lines = config.devices.map(d => {
            const ios = ['do', 'di', 'ai', 'ao']
                .filter(t => d[t])
                .map(t => `${t.toUpperCase()}×${d[t].count}`)
                .join('  ');
            return `• ${d.id}　${d.name}　${d.ip}:${d.port}　${ios || '（無 I/O）'}`;
        });
        return { content: [{ type: 'text', text: `📋 設備清單：\n\n${lines.join('\n')}` }] };
    }
);

// --- 工具 2：read_do_status ---
server.tool(
    'read_do_status',
    `讀取指定設備全部 DO 通道的即時狀態（FC01）。可用設備：${deviceIdList}`,
    { deviceId: z.string().describe(deviceIdDesc) },
    async ({ deviceId }) => {
        try {
            const device = getDevice(deviceId);
            const statuses = await readDoStatus(device);
            return { content: [{ type: 'text', text: fmtDo(device, statuses) }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 3：write_do ---
server.tool(
    'write_do',
    `控制指定設備的單個 DO 通道，立即執行（FC05）。可用設備：${deviceIdList}`,
    {
        deviceId: z.string().describe(deviceIdDesc),
        channel: z.number().int().min(0).describe('DO 通道編號（0 起始）'),
        value: z.number().int().min(0).max(1).describe('0=關閉, 1=開啟')
    },
    async ({ deviceId, channel, value }) => {
        try {
            const device = getDevice(deviceId);
            await writeSingleDo(device, channel, value);
            const actionText = value === 1 ? '開啟' : '關閉';
            return {
                content: [{
                    type: 'text',
                    text: `✅ ${device.name}（${device.ip}）DO${channel} 已${actionText}`
                }]
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 4：batch_write_do ---
server.tool(
    'batch_write_do',
    `批量控制指定設備的多個 DO 通道，立即執行（FC15）。可用設備：${deviceIdList}`,
    {
        deviceId: z.string().describe(deviceIdDesc),
        operations: z.array(z.object({
            channel: z.number().int().min(0).describe('DO 通道編號'),
            value: z.number().int().min(0).max(1).describe('0=關閉, 1=開啟')
        })).min(1).describe('批量操作清單')
    },
    async ({ deviceId, operations }) => {
        try {
            const device = getDevice(deviceId);
            await writeMultipleDo(device, operations);
            const details = operations
                .map(op => `DO${op.channel} → ${op.value === 1 ? 'ON' : 'OFF'}`)
                .join(', ');
            return {
                content: [{
                    type: 'text',
                    text: `✅ ${device.name}（${device.ip}）批量操作完成：${details}`
                }]
            };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 5：read_di_status ---
server.tool(
    'read_di_status',
    `讀取指定設備全部 DI 數位輸入的即時狀態（FC02）。可用設備：${deviceIdList}`,
    { deviceId: z.string().describe(deviceIdDesc) },
    async ({ deviceId }) => {
        try {
            const device = getDevice(deviceId);
            const statuses = await readDiStatus(device);
            return { content: [{ type: 'text', text: fmtDi(device, statuses) }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 6：read_ai_values ---
server.tool(
    'read_ai_values',
    `讀取指定設備全部 AI 類比輸入的數值（FC04）。可用設備：${deviceIdList}`,
    { deviceId: z.string().describe(deviceIdDesc) },
    async ({ deviceId }) => {
        try {
            const device = getDevice(deviceId);
            const values = await readAiValues(device);
            return { content: [{ type: 'text', text: fmtAi(device, values) }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 7：read_ao_values ---
server.tool(
    'read_ao_values',
    `讀取指定設備全部 AO 類比輸出的目前設定值（FC03）。可用設備：${deviceIdList}`,
    { deviceId: z.string().describe(deviceIdDesc) },
    async ({ deviceId }) => {
        try {
            const device = getDevice(deviceId);
            const values = await readAoValues(device);
            return { content: [{ type: 'text', text: fmtAo(device, values) }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    }
);

// --- 工具 8：write_ao ---
server.tool(
    'write_ao',
    `寫入指定設備的單個 AO 類比輸出值，立即執行（FC06）。可用設備：${deviceIdList}`,
    {
        deviceId: z.string().describe(deviceIdDesc),
        channel: z.number().int().min(0).describe('AO 通道編號（0 起始）'),
        value: z.number().int().min(0).max(65535).describe('寫入值（0~65535，依設備量程換算）')
    },
    async ({ deviceId, channel, value }) => {
        try {
            const device = getDevice(deviceId);
            await writeAo(device, channel, value);
            return {
                content: [{
                    type: 'text',
                    text: `✅ ${device.name}（${device.ip}）AO${channel} 已設為 ${value}`
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
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGHUP', cleanup);
