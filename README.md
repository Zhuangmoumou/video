# Video Console

Node.js 视频解析、下载与 FFmpeg 处理服务。支持插件扩展站点解析、浏览器降级嗅探、MP4/M3U8 下载、FFmpeg 压缩/裁剪，并提供 Web 控制台和兼容旧协议的 API。

---

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [密码配置](#密码配置)
- [config.json 配置](#configjson-配置)
- [环境变量](#环境变量)
- [代理配置](#代理配置)
- [目录结构](#目录结构)
- [Web 控制台](#web-控制台)
- [API 接口](#api-接口)
  - [Web 控制台 API（/api/task/*）](#web-控制台-api-apitask)
- [插件系统（mod）](#插件系统mod)
- [分辨率档位](#分辨率档位)

---

## 环境要求

- Node.js ≥ 20
- pnpm
- ffmpeg（命令行可用）
- Chromium（Playwright 使用）

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 安装 Playwright 浏览器（首次）
npx playwright install chromium

# 1. 先配置密码（见下方"密码配置"一节）
# 2. 根据需求编辑 config.json

# 启动
pnpm start
```

默认监听 `9898` 端口，打开浏览器访问 `http://localhost:9898/` 进入登录页。

---

## 密码配置

服务 **必须配置访问密码** 才能启动。密码用于 Web 控制台登录和旧协议 Bearer 鉴权。

### 方式一：使用脚本生成（推荐）

```bash
chmod +x change_password.sh
./change_password.sh
```

输入新密码后，脚本会输出 `scrypt$...` 格式的加密串。将输出内容填入 `config.json` 的 `auth.passwordHash` 字段：

```json
{
    "auth": {
        "passwordHash": "scrypt$F45i6lhSYvOPNaZFteBdPQ==$F1aaBQi1KvHnhstMfeG8PMOiFKVwfRAnlGgzTdwyVnw="
    }
}
```

### 方式二：使用 Node.js 手动生成

```bash
node -e '
const crypto = require("crypto");
const pw = process.argv[1];
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 32);
console.log(`scrypt$${salt.toString("base64")}$${hash.toString("base64")}`);
' "你的密码"
```

### 方式三：环境变量（优先级最高）

```bash
export VIDEO_UI_PASSWORD_HASH="scrypt$..."
pnpm start
```

支持的环境变量（优先级均高于 `config.json`）：

| 环境变量 | 说明 | 示例 |
|----------|------|------|
| `VIDEO_UI_PASSWORD_HASH` | scrypt 格式的密码哈希 | `scrypt$...` |
| `VIDEO_UI_PASSWORD` | 明文密码（不推荐生产使用） | `mypassword` |
| `VIDEO_UI_SESSION_TTL_MS` | 会话有效期（毫秒），默认 12 小时 | `43200000` |
| `VIDEO_UI_LOGIN_WINDOW_MS` | 登录尝试窗口（毫秒），默认 15 分钟 | `900000` |
| `VIDEO_UI_LOGIN_BLOCK_MS` | 触发封锁后的冻结时间（毫秒），默认 30 分钟 | `1800000` |
| `VIDEO_UI_LOGIN_MAX_ATTEMPTS` | 窗口内最大失败次数，默认 5 | `5` |

---

## config.json 配置

运行时配置位于项目根目录的 `config.json`。首次使用请从 `config.example.json` 复制并填写。

```bash
cp config.example.json config.json
```

### 完整配置项

```json
{
    "origin": [
        {
            "name": "xxx",
            "url": "https://xxx.com/xxx/{1}-{2}-{3}"
        },
        {
            "name": "yyy",
            "url": "https://yyy.com/yyy/{1}/{2}/{3}.html"
        }
    ],
    "auth": {
        "passwordHash": "scrypt$...",
        "sessionTtlMs": 43200000,
        "loginWindowMs": 900000,
        "loginBlockMs": 1800000,
        "loginMaxAttempts": 5
    }
}
```

### 配置说明

#### `origin` — 站点快捷跳转

Web 控制台提供"编号 → 打开"功能，将用户输入的编号（如 `1619-3-2`）按 `-` 拆分填入 `{}` 模板拼接为完整 URL 并打开新标签页。

- `name`：显示名称
- `url`：URL 模板，`{1}`、`{2}`、`{3}` 分别对应编号的第 1、2、3 部分

例如编号 `1619-3-2`，模板 `https://xxx.com/xxx/{1}-{2}-{3}` 会生成 `https://xxx.com/xxx/1619-3-2`。

#### `auth` — 鉴权配置

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `passwordHash` | string | 是 | - | scrypt 格式密码哈希，通过 `change_password.sh` 生成 |
| `sessionTtlMs` | number | 否 | 43200000（12h） | Web 控制台会话过期时间 |
| `loginWindowMs` | number | 否 | 900000（15min） | 登录失败计数窗口 |
| `loginBlockMs` | number | 否 | 1800000（30min） | 超过失败上限后的冻结时间 |
| `loginMaxAttempts` | number | 否 | 5 | 窗口内最大登录失败次数 |

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `9898` |
| `VIDEO_UI_PASSWORD_HASH` | 密码哈希（优先于 config.json） | - |
| `VIDEO_UI_PASSWORD` | 明文密码（优先于 config.json） | - |
| `VIDEO_UI_SESSION_TTL_MS` | 会话 TTL | `43200000` |
| `VIDEO_UI_LOGIN_WINDOW_MS` | 登录窗口 | `900000` |
| `VIDEO_UI_LOGIN_BLOCK_MS` | 登录封锁时间 | `1800000` |
| `VIDEO_UI_LOGIN_MAX_ATTEMPTS` | 最大失败次数 | `5` |
| `DOWNLOAD_PROXY` | HTTP 代理（下载流量走代理） | - |
| `VIDEO_PROXY` | 同上，`DOWNLOAD_PROXY` 的备选名 | - |
| `PROXY_DOMAIN` | 域名前缀代理（URL 改写方式） | - |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Chromium 可执行文件路径 | 系统默认 |

---

## 代理配置

服务支持两种代理模式，用于绕过站点/CDN 的地域限制：

### 1. HTTP 代理（`DOWNLOAD_PROXY` / `VIDEO_PROXY`）

直接通过 HTTP CONNECT 隧道转发下载流量和浏览器流量：

```bash
export DOWNLOAD_PROXY="http://user:pass@proxy.example.com:8080"
pnpm start
```

格式：`http://[user:pass@]host:port`

设置后，Playwright 浏览器和 axios 下载请求均走该代理。与 `PROXY_DOMAIN` 互斥：HTTP 代理设置后不再使用 URL 改写。

### 2. URL 改写代理（`PROXY_DOMAIN`）

将下载链接前缀替换为代理域名：

```bash
export PROXY_DOMAIN="https://proxy.example.com"
pnpm start
```

例如原始链接 `https://cdn.example.com/video.mp4`，经代理改写为 `https://proxy.example.com/cdn.example.com/video.mp4`。仅影响下载流量，不影响浏览器请求。

---

## 目录结构

```text
app.js                   启动入口
config.json              运行时配置（origin、auth）
config.example.json      配置模板
change_password.sh       密码哈希生成脚本
package.json             项目依赖与脚本
pnpm-lock.yaml           锁文件

src/
├── createApp.js         Express 应用装配（路由注册、中间件）
├── config.js            常量、分辨率预设、配置读取
├── auth.js              Web 控制台会话管理 & Bearer 鉴权
├── taskManager.js       单任务锁、队列状态、资源释放
├── taskService.js       下载任务编排与队列流程
├── mediaResolver.js     插件调用与 Playwright 浏览器嗅探
├── videoProcessor.js    FFmpeg 压缩、裁剪片段与拼接
├── modLoader.js         插件加载、标准化、裁剪区间解析
├── logStore.js          日志缓冲区与控制台捕获
├── download/
│   ├── mp4.js           MP4 流式下载（含 302 跟随、代理支持）
│   └── m3u8.js          M3U8 分片下载与拼合
├── routes/
│   ├── auth.js          登录/登出、会话检查
│   ├── ui.js            控制台 Bootstrap 状态 & 兼容资源
│   ├── tasks.js         /api/task/* 前端 API
│   └── legacy.js        POST / 旧协议兼容 API
└── utils/
    ├── validation.js    参数校验与安全工具
    ├── progress.js      进度节流与速率估算
    └── objectLiteral.js 安全 JavaScript 对象字面量解析

mod/                     站点解析插件
├── mod.md               插件编写规范
├── mgnacg.js            默认编号插件
├── danzhu.js            项目自带1
└── sorani.js            项目自带2

pages/                   HTML 页面
├── login.html           登录页
└── console.html         控制台页

public/                  浏览器静态资源
├── styles.css           全局样式
├── login.js             登录页交互
└── console.js           控制台交互

mp4/                     下载/输出目录
└── out/                 压缩输出目录（通过 /dl/ 提供下载）

```

---

## Web 控制台

启动后打开 `http://localhost:9898/`：

1. **登录**：输入配置的密码
2. **任务面板**：选择分辨率、输入 URL（支持单任务和多任务逗号队列）、可选自定义文件名和 mod 指定
3. **实时进度**：流式显示解析、下载、压缩进度
4. **文件管理**：查看已完成的文件列表，支持下载
5. **站点快捷跳转**：根据 `config.json` 的 origin 配置，输入编号直接打开对应站点

---

## API 接口

服务提供两套 API：Web 控制台使用的 `/api/task/*`（Cookie 鉴权）

### Web 控制台 API（/api/task/*）

**所有接口需要先通过 Cookie 会话鉴权。**

#### GET /api/auth/status

查询鉴权状态。

**响应**：
```json
{
    "configured": true,
    "authenticated": true,
    "sessionExpiresAt": 1717200000000
}
```

#### GET /api/ui/bootstrap

获取控制台启动数据（状态、已加载插件、输出文件列表）。

#### GET /api/ui/state

获取当前服务状态快照。

#### POST /api/task

提交下载任务（流式 JSON lines 响应）。

**请求体**：
```json
{
    "url": "1619-3-2",
    "code": 1,
    "file": "可选文件名",
    "mod": "可选插件名",
    "resolution": "720p"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 页面链接 / 编号 / 插件输入。可用逗号分隔多个 |
| `code` | 是 | 正整数任务编号 |
| `file` | 否 | 输出文件名（不含 `.mp4`），支持逗号分隔对应多任务 |
| `mod` | 否 | 指定插件名，留空自动选择 |
| `resolution` | 否 | 压缩分辨率，默认 `720p` |

**流式响应示例**：
```json
{"type":"msg","content":"🔌 使用插件解析: mgnacg"}
{"type":"msg","content":"📄 页面标题: 某番剧第3话"}
{"type":"msg","content":"📥 下载: 45% (23.50/52.00MB) 2.1MB/s"}
{"type":"msg","content":"📦 压缩: 78% (12.30MB)"}
{"type":"url","url":"https://host/dl/output.mp4","title":"某番剧第3话"}
```

#### POST /api/task/stop

停止当前任务。

#### POST /api/task/rm

停止当前任务并清理 `mp4/` 及 `mp4/out/` 中的所有文件。

### 旧协议 API（POST /）

兼容旧客户端和简单 API 对接。使用 `Authorization: Bearer <密码>` 鉴权。

```bash
curl -N -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 你的密码' \
  -d '{"url":"1619-3-2","code":1}' \
  http://127.0.0.1:9898/
```

**支持的命令**：

| 请求 | 说明 |
|------|------|
| `{"url":"...","code":n}` | 提交下载任务 |
| `"log"` / `{"log":true}` | 获取日志文件下载地址 |
| `"ls"` / `{"ls":true}` | 列出输出文件 |
| `"stop"` / `{"stop":true}` | 停止当前任务 |
| `"rm"` / `{"rm":true}` | 停止任务并清空输出目录 |
| `"kill"`/`{"kill":n}` | 中止指定 code 的任务 |

**任务请求字段**（与 Web API 一致）：

```json
{
    "url": "1619-3-2",
    "code": 1001,
    "file": "可选文件名",
    "mod": "可选插件名",
    "resolution": "720p"
}
```

---

## 插件系统（mod）

服务通过 `mod/` 目录下的脚本扩展站点解析能力。详细编写规范见 [`mod/mod.md`](mod/mod.md)。

### 内置插件

| 插件 | 文件 | 适用站点 |
|------|------|----------|
| `mgnacg` | `mod/mgnacg.js` | 默认编号插件，解析选集编号为直链 |
| `danzhu` | `mod/danzhu.js` | dm.danzhuacg.com，输出 m3u8 并剔除广告分片 |
| `sorani` | `mod/sorani.js` | www.sorani.net，解析 AES-128 加密 m3u8 |

### 任务解析策略

| 请求 | 插件选择 | 失败回退 |
|------|----------|----------|
| 纯编号（无 `mod`） | 默认 `mgnacg` | 回退浏览器嗅探 |
| mgnacg.com URL | 默认 `mgnacg` | 回退浏览器嗅探 |
| 指定 `mod` | 强制使用指定插件 | 不回退 |
| 其他完整 URL | 不走插件 | 直接浏览器嗅探 |

### 本地调试插件

```bash
# 单独运行插件
node mod/mgnacg.js 1619-3-2
```

---

## 分辨率档位

| ID | 标签 | 说明 |
|----|------|------|
| `source` | 原画质 | 保留原始分辨率，无裁剪时直接输出 |
| `1080p` | 1080p | 最长边 ≤ 1920×1080 |
| `720p` | 720p | 最长边 ≤ 1280×720（默认） |
| `480p` | 480p | 最长边 ≤ 854×480 |
| `360p` | 360p | 最长边 ≤ 640×360 |


FFmpeg 编码参数：H.264（libx264），CRF 17（source 档位 CRF 15），preset medium，音频流直接复制。

---

## 测试

```bash
# 语法检查
pnpm run check

#运行
pnpm start
```
