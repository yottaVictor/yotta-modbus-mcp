/**
 * Yotta Modbus MCP Server — 共用核心模組
 *
 * 此模組包含所有 Modbus 操作邏輯與 MCP Server 工廠函數
 * 由 index.js（stdio）及 stream.js（HTTP）共同引用
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import ModbusRTU from 'modbus-serial';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { lookupSpec } from './device-specs.js';

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
const configPath = join(__dirname, '..', 'config.json');

let config = JSON.parse(readFileSync(configPath, 'utf-8'));
let deviceMap = new Map(config.devices.map(d => [d.id, d]));

function saveConfig() {
    writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf-8');
    deviceMap = new Map(config.devices.map(d => [d.id, d]));
}

function getDevice(deviceId) {
    const device = deviceMap.get(deviceId);
    if (!device) throw new Error(`找不到設備 "${deviceId}"，有效 ID：${[...deviceMap.keys()].join(', ')}`);
    return device;
}

function requireIO(device, ioType) {
    if (!device[ioType]) throw new Error(`設備 "${device.id}"（${device.name}）不具備 ${ioType.toUpperCase()} 通道`);
    return device[ioType];
}

function initLabels(ioType, count) {
    return Array.from({ length: count }, (_, i) => `${ioType.toUpperCase()}${i}`);
}

function getLabel(device, ioType, channel) {
    const io = device[ioType];
    const prefix = ioType.toUpperCase();
    const defaultName = `${prefix}${channel}`;
    const label = io?.labels?.[channel];
    if (label && label !== defaultName) {
        return `${prefix}${channel} (${label})`;
    }
    return defaultName;
}

// ============================================================
// Modbus TCP 連線管理（connect-use-disconnect）
// ============================================================
async function withModbus(device, fn) {
    return await withLock(async () => {
        const client = new ModbusRTU();
        console.error(`[Modbus] 連線到 ${device.name}（${device.ip}:${device.port}）...`);
        try {
            await Promise.race([
                client.connectTCP(device.ip, { port: device.port }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TCP 連線超時 (Timeout)')), 3000))
            ]);
            client.setID(device.slaveId);
            client.setTimeout(5000);
            return await fn(client);
        } catch (err) {
            console.error(`[Modbus] 操作失敗: ${err.message}`);
            throw err;
        } finally {
            try {
                if (client._port?.destroy) client._port.destroy();
                else if (client.isOpen) await new Promise(r => client.close(r));
                console.error(`[Modbus] 連線已關閉`);
            } catch (e) {
                console.error(`[Modbus] 關閉時發生錯誤（忽略）: ${e.message}`);
            }
        }
    });
}

// ============================================================
// Modbus 操作函式
// ============================================================
async function readDo(device) {
    const io = requireIO(device, 'do');
    return await withModbus(device, async (c) => (await c.readCoils(io.baseAddress, io.count)).data.slice(0, io.count));
}
async function readDi(device) {
    const io = requireIO(device, 'di');
    return await withModbus(device, async (c) => (await c.readDiscreteInputs(io.baseAddress, io.count)).data.slice(0, io.count));
}
async function readAi(device) {
    const io = requireIO(device, 'ai');
    return await withModbus(device, async (c) => (await c.readInputRegisters(io.baseAddress, io.count)).data.slice(0, io.count));
}
async function readAo(device) {
    const io = requireIO(device, 'ao');
    return await withModbus(device, async (c) => (await c.readHoldingRegisters(io.baseAddress, io.count)).data.slice(0, io.count));
}
async function writeSingleDo(device, channel, value) {
    const io = requireIO(device, 'do');
    if (channel >= io.count) throw new Error(`DO${channel} 超出範圍，最大 DO${io.count - 1}`);
    await withModbus(device, async (c) => c.writeCoil(io.baseAddress + channel, value === 1));
}
async function writeMultipleDo(device, operations) {
    const io = requireIO(device, 'do');
    await withModbus(device, async (c) => {
        const cur = (await c.readCoils(io.baseAddress, io.count)).data;
        for (const op of operations) cur[op.channel] = op.value === 1;
        await c.writeCoils(io.baseAddress, cur);
    });
}
async function writeSingleAo(device, channel, value) {
    const io = requireIO(device, 'ao');
    if (channel >= io.count) throw new Error(`AO${channel} 超出範圍，最大 AO${io.count - 1}`);
    await withModbus(device, async (c) => c.writeRegister(io.baseAddress + channel, value));
}

// ============================================================
// MCP Server 工廠（每次呼叫建立全新實例）
// ============================================================
export function createMcpServer() {
    const server = new McpServer({ name: 'yotta-modbus', version: '4.3.0' });
    const deviceIdDesc = '設備 ID';
    const ioSchema = z.object({ count: z.number().int().min(1), baseAddress: z.number().int().min(0) }).nullable();

    // ── 設備管理 ──────────────────────────────────────────────────
    server.tool('list_devices', '列出所有已註冊的 Modbus 設備及其 I/O 配置。', {},
        async () => {
            const lines = config.devices.map(d => {
                const ios = ['do', 'di', 'ai', 'ao'].filter(t => d[t]).map(t => `${t.toUpperCase()}×${d[t].count}`).join(' ');
                return `• ${d.id}　${d.name}　${d.ip}:${d.port}　${ios || '（無 I/O）'}`;
            });
            return { content: [{ type: 'text', text: `📋 設備清單：\n\n${lines.join('\n')}` }] };
        }
    );

    server.tool('add_device', '新增一台 Modbus 設備並儲存至 config，立即生效無需重啟。name/port/slaveId 有預設值可省略。', {
        id: z.string().describe('唯一識別碼，例如 "A1869-2F"'),
        name: z.string().optional().describe('設備名稱（預設同 id）'),
        ip: z.string().describe('IP 位址'),
        port: z.number().int().optional().describe('TCP Port（預設 502）'),
        slaveId: z.number().int().min(1).max(247).optional().describe('Modbus Slave ID（預設 1）'),
        do: ioSchema.optional().describe('DO 設定，無則省略'),
        di: ioSchema.optional().describe('DI 設定，無則省略'),
        ai: ioSchema.optional().describe('AI 設定，無則省略'),
        ao: ioSchema.optional().describe('AO 設定，無則省略'),
    }, async ({ id, name, ip, port = 502, slaveId = 1, do: doIO = null, di = null, ai = null, ao = null }) => {
        try {
            if (deviceMap.has(id)) throw new Error(`設備 ID "${id}" 已存在`);
            const dev = { id, name: name ?? id, ip, port, slaveId, do: doIO, di, ai, ao };
            for (const t of ['do', 'di', 'ai', 'ao']) {
                if (dev[t] && !dev[t].labels) dev[t].labels = initLabels(t, dev[t].count);
            }
            config.devices.push(dev);
            saveConfig();
            const ios = ['do', 'di', 'ai', 'ao'].filter(t => dev[t]).map(t => `${t.toUpperCase()}×${dev[t].count}`).join(' ');
            return { content: [{ type: 'text', text: `✅ 設備 "${id}"（${dev.name} ${ip}:${port}）已新增。I/O：${ios || '（無）'}` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    server.tool('remove_device', '移除一台已註冊的 Modbus 設備，立即生效。', {
        deviceId: z.string().describe(deviceIdDesc)
    }, async ({ deviceId }) => {
        try {
            getDevice(deviceId);
            config.devices = config.devices.filter(d => d.id !== deviceId);
            saveConfig();
            return { content: [{ type: 'text', text: `✅ 設備 "${deviceId}" 已移除` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    server.tool('update_device', '修改已註冊設備的參數（IP、port、name 等），只需傳入要變更的欄位，立即生效。', {
        deviceId: z.string().describe(deviceIdDesc),
        name: z.string().optional(), ip: z.string().optional(),
        port: z.number().int().optional(), slaveId: z.number().int().min(1).max(247).optional(),
        do: ioSchema.optional(), di: ioSchema.optional(), ai: ioSchema.optional(), ao: ioSchema.optional(),
    }, async ({ deviceId, ...updates }) => {
        try {
            const device = getDevice(deviceId);
            Object.assign(device, updates);
            saveConfig();
            return { content: [{ type: 'text', text: `✅ 設備 "${deviceId}" 已更新：${JSON.stringify(updates)}` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    server.tool('lookup_device_spec', '依 Yotta 設備型號查詢 I/O 規格（DO/DI/AI/AO 數量與 Modbus 位址），可搭配 add_device 使用。', {
        model: z.string().describe('設備型號，例如 "A-1812"')
    }, async ({ model }) => {
        try {
            const spec = lookupSpec(model);
            if (!spec) throw new Error(`找不到型號 "${model}" 的規格資料`);
            const ios = ['do', 'di', 'ai', 'ao'].filter(t => spec[t])
                .map(t => `${t.toUpperCase()}×${spec[t].count}（baseAddress: ${spec[t].baseAddress}）`).join('\n  ');
            return { content: [{ type: 'text', text: `📋 ${model} 規格：\n\n  ${ios || '（無 I/O）'}` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    // ── 通道命名 ─────────────────────────────────────────────────
    server.tool('list_channels', '列出指定設備的所有通道及其自訂名稱。', {
        deviceId: z.string().describe(deviceIdDesc),
        type: z.enum(['do', 'di', 'ai', 'ao', 'all']).optional().describe('通道類型，預設 all')
    }, async ({ deviceId, type = 'all' }) => {
        try {
            const d = getDevice(deviceId);
            const sections = [];
            const ioTypes = type === 'all' ? ['do', 'di', 'ai', 'ao'] : [type];
            for (const t of ioTypes) {
                if (!d[t]) continue;
                const io = d[t];
                const header = { do: '📡 DO', di: '📥 DI', ai: '📊 AI', ao: '📤 AO' }[t];
                sections.push(`${header}：`);
                for (let i = 0; i < io.count; i++) {
                    const label = io.labels?.[i] || `${t.toUpperCase()}${i}`;
                    sections.push(`  ${t.toUpperCase()}${i}: ${label}`);
                }
            }
            if (sections.length === 0) {
                return { content: [{ type: 'text', text: `⚠️ ${d.name} 不具備 ${type.toUpperCase()} 通道` }] };
            }
            return { content: [{ type: 'text', text: `📋 ${d.name} 通道名稱：\n${sections.join('\n')}` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    server.tool('rename_channel', '為指定通道設定或清除自訂名稱，儲存至 config 立即生效。', {
        deviceId: z.string().describe(deviceIdDesc),
        type: z.enum(['do', 'di', 'ai', 'ao']).describe('通道類型'),
        channel: z.number().int().min(0).describe('通道編號（0 起始）'),
        label: z.string().describe('自訂名稱，空字串表示清除命名')
    }, async ({ deviceId, type, channel, label }) => {
        try {
            const d = getDevice(deviceId);
            const io = requireIO(d, type);
            if (channel >= io.count) throw new Error(`${type.toUpperCase()}${channel} 超出範圍，最大 ${type.toUpperCase()}${io.count - 1}`);
            if (!io.labels) io.labels = initLabels(type, io.count);
            io.labels[channel] = label;
            saveConfig();
            const display = label ? `「${label}」` : '（已清除）';
            return { content: [{ type: 'text', text: `✅ ${d.name} ${type.toUpperCase()}${channel} 命名為 ${display}` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    // ── I/O 讀取 ─────────────────────────────────────────────────
    server.tool('read_io', '讀取指定設備的 I/O 通道狀態。type=all 可一次讀取全部通道。', {
        deviceId: z.string().describe(deviceIdDesc),
        type: z.enum(['do', 'di', 'ai', 'ao', 'all']).describe('通道類型：do=數位輸出(FC01) / di=數位輸入(FC02) / ai=類比輸入(FC04) / ao=類比輸出(FC03) / all=全部')
    }, async ({ deviceId, type }) => {
        try {
            const d = getDevice(deviceId);
            const sections = [];
            if ((type === 'all' || type === 'do') && d.do) {
                const s = await readDo(d);
                sections.push(`📡 DO 狀態：`, ...s.map((v, i) => `  ${getLabel(d, 'do', i)}: ${v ? 'ON 🟢' : 'OFF ⚫'}`));
            }
            if ((type === 'all' || type === 'di') && d.di) {
                const s = await readDi(d);
                sections.push(`📥 DI 狀態：`, ...s.map((v, i) => `  ${getLabel(d, 'di', i)}: ${v ? 'ON 🟢' : 'OFF ⚫'}`));
            }
            if ((type === 'all' || type === 'ai') && d.ai) {
                const s = await readAi(d);
                sections.push(`📊 AI 數值：`, ...s.map((v, i) => `  ${getLabel(d, 'ai', i)}: ${v}`));
            }
            if ((type === 'all' || type === 'ao') && d.ao) {
                const s = await readAo(d);
                sections.push(`📤 AO 數值：`, ...s.map((v, i) => `  ${getLabel(d, 'ao', i)}: ${v}`));
            }
            if (sections.length === 0) {
                return { content: [{ type: 'text', text: `⚠️ ${d.name}（${d.ip}）不具備 ${type.toUpperCase()} 通道` }] };
            }
            return { content: [{ type: 'text', text: `🔍 ${d.name}（${d.ip}）I/O 狀態：\n${sections.join('\n')}` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    // ── I/O 控制 ─────────────────────────────────────────────────
    server.tool('write_do', '控制指定設備的 DO 通道，單個或批量皆可（FC05/FC15）。', {
        deviceId: z.string().describe(deviceIdDesc),
        operations: z.array(z.object({
            channel: z.number().int().min(0).describe('DO 通道編號（0 起始）'),
            value: z.number().int().min(0).max(1).describe('0=關閉, 1=開啟')
        })).min(1).describe('操作清單，單個操作傳 1 個元素，批量傳多個。注意：channel 直接對應設備的 DO 編號，例如使用者說「DO5」就傳 channel=5，DO0 就傳 channel=0，不需要做任何加減轉換')
    }, async ({ deviceId, operations }) => {
        try {
            const d = getDevice(deviceId);
            if (operations.length === 1) {
                const { channel, value } = operations[0];
                await writeSingleDo(d, channel, value);
                return { content: [{ type: 'text', text: `✅ ${d.name}（${d.ip}）${getLabel(d, 'do', channel)} 已${value ? '開啟' : '關閉'}` }] };
            } else {
                await writeMultipleDo(d, operations);
                const details = operations.map(op => `${getLabel(d, 'do', op.channel)}→${op.value ? 'ON' : 'OFF'}`).join(', ');
                return { content: [{ type: 'text', text: `✅ ${d.name}（${d.ip}）批量操作完成：${details}` }] };
            }
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    server.tool('write_ao', '寫入指定設備的單個 AO 類比輸出值，立即執行（FC06）。channel 直接對應 AO 編號，例如 AO2 就傳 channel=2。', {
        deviceId: z.string().describe(deviceIdDesc),
        channel: z.number().int().min(0).describe('AO 通道編號（0 起始），直接對應設備 AO 編號，例如 AO2 就傳 2'),
        value: z.number().int().min(0).max(65535).describe('寫入值（0~65535）')
    }, async ({ deviceId, channel, value }) => {
        try {
            const d = getDevice(deviceId);
            await writeSingleAo(d, channel, value);
            return { content: [{ type: 'text', text: `✅ ${d.name}（${d.ip}）${getLabel(d, 'ao', channel)} 已設為 ${value}` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
        }
    });

    return server;
}
