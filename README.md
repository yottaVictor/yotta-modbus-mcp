# Yotta Modbus MCP Server

透過 MCP (Model Context Protocol) 控制 Yotta I/O 模組（Modbus TCP）。

## 功能

- 新增/移除/查詢 Modbus 設備
- 讀取 DO（數位輸出）、DI（數位輸入）、AI（類比輸入）、AO（類比輸出）
- 控制 DO/AO 通道
- 設備 ping 檢測
- 通道自訂命名

## 安裝

```bash
npm install
```

## 啟動

```bash
npm start
```

## 可用工具

| 工具 | 說明 |
|------|------|
| `add_device` | 新增 Modbus 設備 |
| `remove_device` | 移除設備 |
| `update_device` | 修改設備參數 |
| `list_devices` | 列出所有設備 |
| `list_channels` | 列出設備通道 |
| `rename_channel` | 設定通道名稱 |
| `lookup_device_spec` | 查詢設備型號規格 |
| `ping_device` | 檢測設備連線 |
| `read_io` | 讀取 I/O 狀態 |
| `write_do` | 控制 DO 通道 |
| `write_ao` | 寫入 AO 值 |

## 設定檔

`config.json` - 設備 I/O 設定