# 插件编写规范（mod）

本服务支持通过 `mod/` 目录下的脚本扩展「解析视频下载地址」能力。  
启动时会自动扫描并加载所有符合规范的插件。

---

## 1. 放置位置与命名

| 项 | 要求 |
|----|------|
| 目录 | 项目根目录下的 `mod/` |
| 文件 | 仅加载 `*.js` |
| 插件名 | 文件名去掉 `.js` 后的部分 |
| 合法字符 | 仅允许 `a-z` `A-Z` `0-9` `_` `-` |

示例：

- `mod/mgnacg.js` → 插件名 `mgnacg`
- `mod/my_site.js` → 插件名 `my_site`

非法名称（含路径、空格、特殊字符等）会被拒绝。

---

## 2. 必须导出的接口

插件必须是 **CommonJS 模块**，并导出异步（或同步）函数 **`download`**：

```js
/**
 * @param {string} input  任务请求里的 url 字段原样传入
 * @param {object} [options]  主程序固定传入 `{ meta: true }`（详见下方 2.1.1）
 *   - options.meta  (boolean)：true 时返回完整元数据对象，false/不传时返回字符串
 *   - options.site  (string)：可选，覆盖站点根 URL（仅部分插件使用）
 * @returns {Promise<string|object>|string|object}
 */
async function download(input, options = {}) {
  // ...
  return 'https://example.com/video.mp4';
}

module.exports = { download };
```

### 2.1 入参 `input`

- 来自请求 JSON 的 **`url` 字段原样传入**，不做协议校验。
- 可能是：
  - 站点编号：`1619-3-2`
  - 路径：`bangumi/1619-3-2`
  - 完整页面 URL：`https://...`
  - 其它自定义字符串（仅在用户显式指定 `mod` 时有意义）

插件应自行校验/规范化 `input`，格式不对时 **抛出 Error**。

### 2.1.1 入参 `options`

主程序调用插件时固定传入 `{ meta: true }`：

| 字段 | 类型 | 主程序行为 | 含义 |
|------|------|-----------|------|
| `meta` | boolean | **始终传 `true`** | `true` 时要求返回完整元数据对象（下方 B 类）；`false` 时返回媒体 URL 字符串（下方 A 类）。建议同时支持两种模式，CLI 调试走 `meta: false`，主程序调用走 `meta: true` |
| `signal` | `AbortSignal` | **停止任务时传入** | 用户点「停止」时主程序会 abort 该信号。插件应把它传给 axios/`fetch` 等请求，并在长循环间检查 `signal.aborted`，否则解析阶段无法被打断 |
| `site` | string | 不传 | 仅 `mgnacg` 等特定插件使用，允许覆盖站点根 URL，默认取插件内置常量 |

> 主程序在调用插件时还会用 `AbortSignal` 与插件 Promise 竞速：即便旧插件未处理 `signal`，停止也能立刻结束等待；但只有插件真正把 `signal` 传给网络请求，才能取消底层 HTTP。

### 2.2 返回值（二选一）

主程序通过 `normalizeModResult` 统一处理，支持：

#### A. 字符串（最简）

直接返回媒体直链，支持以下形式：

- 远程 `http(s)` 链接：`https://cdn.example.com/a.mp4` 或 `https://cdn.example.com/index.m3u8`
- 本地 m3u8 绝对路径：`/tmp/danzhu_xxx.m3u8`（用于播放后改写 playlist 再下载）：

```js
return 'https://cdn.example.com/a.mp4';
// 或
return 'https://cdn.example.com/index.m3u8';
```

#### B. 对象（推荐，可带 Referer）

```js
return {
  url: 'https://cdn.example.com/a.mp4', // 必填（也可用 mediaUrl）
  pageUrl: 'https://site.example/play/1', // 可选，用作下载 Referer
  pageTitle: '某番剧 第3话', // 可选，写入日志并回传给客户端
  cutRanges: [{ start: 364, end: 384 }], // 可选，压缩时删除的片段，单位秒
  // referer / refererUrl 同样可被识别为 Referer
};
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` 或 `mediaUrl` | 是 | 最终可下载的媒体地址（mp4 / m3u8 等）；内置插件也可返回绝对路径的本地 m3u8 |
| `pageUrl` / `referer` / `refererUrl` | 否 | 下载时的 Referer/Origin 来源页 |
| `pageTitle` / `title` / `vod_name` | 否 | 视频标题；打印到任务日志，并作为完成响应里的 `title` 字段回传。三个别名按此优先级取首个非空值，**只需返回其中一个** |
| `cutRanges` | 否 | 压缩时删除的片段数组，如 `[{ "start": 364, "end": 384 }]`；也支持 `MM:SS` / `HH:MM:SS` 字符串 |

其它字段可自行附加（便于调试），主程序会保留在内部 meta 中，但不保证对外暴露。

### 2.3 失败时

- 请 **`throw new Error('可读原因')`**
- 不要返回 `null` / `undefined` / 空字符串
- 返回的媒体地址若不是 `http(s)` 或绝对路径的本地 m3u8，主程序会报错并中止任务

---

## 3. 主程序如何调用插件

### 3.1 启动加载

服务启动时调用 `loadMods()`：

1. 读取 `mod/*.js`
2. `require` 模块
3. 检查 `typeof mod.download === 'function'`
4. 以「文件名去后缀」为 key 注册

日志示例：

```text
[Mod] 已加载插件: mgnacg (mgnacg.js)
[Mod] 共加载 1 个插件: mgnacg
```

加载失败或未导出 `download` 的文件会被跳过，并打印错误日志。

> 修改插件后需 **重启服务** 才会重新加载（启动时会清理 `require` 缓存）。

### 3.2 任务解析策略

| 请求形态 | 使用插件 | 失败是否回退浏览器 |
|----------|----------|--------------------|
| `{ "url": "编号", "code": n }`（无 `mod`） | 默认优先 `mgnacg` | **会**回退浏览器抓取 |
| `{ "url": "编号1,编号2,编号3", "code": n }`（无 `mod`） | 按逗号拆成队列，逐个默认优先 `mgnacg` | **会**逐项回退浏览器抓取 |
| `{ "url": "https://mgnacg.com/...", "code": n }`（无 `mod`） | 默认优先 `mgnacg` | **会**回退浏览器抓取 |
| `{ "url": "...", "code": n, "mod": "xxx" }` | 强制 `xxx` | **不会**回退 |
| `{ "url": "https://页面...", "code": n }`（无 `mod`） | 不走插件 | 直接浏览器抓取 |

说明：

- 默认编号任务依赖名为 **`mgnacg`** 的插件；没有该插件时直接浏览器。
- `url` 字段可以用英文逗号分割多个任务；服务端仍然只会同时执行一个任务，并按传入顺序串行处理队列。
- `file` 字段也可以用英文逗号分割多个输出文件名，并按顺序对应队列任务；队列只传单个 `file` 时仍会自动追加 `_1`、`_2` 后缀。
- 无 `mod` 时，域名匹配 `mgnacg.com` 的完整 URL 也会先走 `mgnacg` 插件，失败后回退浏览器。
- 用户指定 `mod` 时，`url` 可能不是网页链接，因此 **禁止** 再回退浏览器。

### 3.3 请求 JSON 字段

```json
{
  "url": "1619-3-2",
  "code": 1001,
  "file": "可选自定义文件名(不含扩展名)",
  "mod": "可选插件名，不含.js"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 页面链接 / 编号 / 传给插件的任意输入 |
| `code` | 是 | 任务编号（客户端标识，用于并发互斥等） |
| `file` | 否 | 输出文件名（不含 `.mp4`） |
| `mod` | 否 | 插件名，对应 `mod/<name>.js` |

示例：

```json
// 默认：优先 mgnacg 插件
{ "url": "1619-3-2", "code": 1 }

// 显式指定插件（失败不回退浏览器）
{ "url": "1619-3-2", "code": 1, "mod": "mgnacg" }

// 直接打开页面用浏览器嗅探（不走插件）
{ "url": "https://example.com/play/1", "code": 1 }

// 队列：按顺序逐个处理，仍然不会并发执行
{ "url": "1619-3-2,1619-3-3,1619-3-4", "code": 1 }

// 队列：文件名按逗号顺序对应每个任务
{ "url": "1619-3-2,1619-3-3,1619-3-4", "file": "ep2,ep3,ep4", "code": 1 }

// 指定 danzhu 插件，可传完整 URL 或编号
{ "url": "6477-1-1", "code": 1, "mod": "danzhu" }

// 指定 sorani 插件（青空次元，返回 m3u8）
{ "url": "https://www.sorani.net/anime/mal/4634/episode/01", "code": 1, "mod": "sorani" }
```

---

## 4. 插件解析成功后主程序做什么

1. 取到 `mediaUrl`（及可选 Referer）
2. 组装下载请求头（UA、Accept；若有 Referer 则带 Referer/Origin）
3. 判断是否 m3u8：
   - 含 `.m3u8` → M3U8 分片下载
   - 否则 → MP4 流式下载（支持手动跟随 302；跨站会剥离 Referer/Origin/Cookie）
4. FFmpeg 压缩到 `mp4/out/`；若插件返回 `cutRanges`，在压缩阶段删除对应片段

插件 **只负责解析出可下载地址**，可选提供剪辑参数；不负责落盘、转码、进度上报。

---

## 5. 编写建议

1. **纯 Node 解析优先**：HTTP + 解密/正则即可，避免依赖浏览器。
2. **超时与错误信息**：axios 等请求加 timeout；`Error.message` 写清失败步骤，便于日志排查。
3. **支持停止**：把 `options.signal` 传给所有 HTTP 请求；长循环/重试/sleep 中检查 `signal.aborted`，中止时抛 `AbortError`（或 `new Error('任务被中止')`）。
4. **Referer 尽量返回**：若对象存储/CDN 校验来源，请在返回对象里带 `pageUrl`。
5. **不要跟随到最终 302 文件流**：返回「播放器使用的媒体 URL」即可；MP4 的 302 中转由主程序处理。
6. **副作用要小**：启动 `require` 时不要做网络请求；重逻辑放在 `download` 内。
7. **依赖**：可使用项目已安装依赖（如 `axios`）；新增依赖需写进根目录 `package.json`。
8. **安全**：`download` 的 `input` 来自外部请求，注意注入与路径穿越；不要 `eval` 不可信内容。

---

## 6. 最小模板

```js
// mod/demo.js
const axios = require('axios');

async function download(input) {
  const id = String(input || '').trim();
  if (!id) throw new Error('input 不能为空');

  // 示例：根据 id 请求站点 API / 页面，解析出直链
  // const html = (await axios.get(`https://example.com/play/${id}`, { timeout: 15000 })).data;
  // const mediaUrl = ...;

  const mediaUrl = 'https://example.com/demo.mp4'; // 替换为真实解析结果
  if (!/^https?:\/\//i.test(mediaUrl)) {
    throw new Error('解析结果不是合法 URL');
  }

  return {
    url: mediaUrl,
    pageUrl: `https://example.com/play/${encodeURIComponent(id)}`,
  };
}

module.exports = { download };

// 本地调试: node mod/demo.js <input>
if (require.main === module) {
  download(process.argv[2] || 'test')
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('[demo] failed:', e.message);
      process.exit(1);
    });
}
```

---

## 7. 本地调试

```bash
# 单独跑插件（推荐每个插件像 mgnacg 一样支持 require.main）
node mod/mgnacg.js 1619-3-2
```

任务日志中与插件相关的标识：

- `🔌 使用插件解析: <name>`
- `🔌 插件 <name> 解析成功: ...`
- `❌ 插件 <name> 解析失败: ...`（指定 mod，不回退）
- `⚠️ 插件 mgnacg 解析失败，回退浏览器抓取: ...`（默认编号任务）

---

## 8. 内置示例

| 插件 | 文件 | 说明 |
|------|------|------|
| `mgnacg` | `mod/mgnacg.js` | 解析 mgnacg 选集编号为媒体直链；默认编号任务会优先调用 |
| `danzhu` | `mod/danzhu.js` | 解析 dm.danzhuacg.com 播放页/编号为 m3u8，并在 playlist 层剔除广告分片 |
| `sorani` | `mod/sorani.js` | 解析 www.sorani.net 番剧编号/URL 为 AES-128 m3u8 直链（需带站点 Referer） |

参考实现与线路说明见 `mgnacg.js` 文件头注释。
