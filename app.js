const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { downloadM3U8 } = require('./m3u8Downloader');

const app = express();
const PORT = 9898;

const ROOT_DIR = path.join(process.cwd(), 'mp4');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const MOD_DIR = path.join(process.cwd(), 'mod');
fs.ensureDirSync(ROOT_DIR);
fs.ensureDirSync(OUT_DIR);
fs.ensureDirSync(MOD_DIR);

// === 插件系统 ===
/** @type {Map<string, { name: string, file: string, download: Function }>} */
const mods = new Map();

const sanitizeModName = (name) => {
    if (name == null || name === '') return null;
    const n = String(name).trim().replace(/\.js$/i, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(n)) {
        throw new Error(`非法 mod 名称: ${name}`);
    }
    return n;
};

const loadMods = () => {
    mods.clear();
    if (!fs.existsSync(MOD_DIR)) {
        console.log('[Mod] mod 目录不存在，跳过加载');
        return;
    }
    const files = fs.readdirSync(MOD_DIR).filter((f) => f.endsWith('.js'));
    for (const file of files) {
        const name = file.replace(/\.js$/i, '');
        const full = path.join(MOD_DIR, file);
        try {
            // 允许热重载：清掉 require 缓存
            delete require.cache[require.resolve(full)];
            const mod = require(full);
            if (typeof mod?.download !== 'function') {
                console.error(`[Mod] 跳过 ${file}: 未导出 download 函数`);
                continue;
            }
            mods.set(name, { name, file, download: mod.download.bind(mod) });
            console.log(`[Mod] 已加载插件: ${name} (${file})`);
        } catch (e) {
            console.error(`[Mod] 加载失败 ${file}:`, e?.message || e);
        }
    }
    console.log(`[Mod] 共加载 ${mods.size} 个插件: ${[...mods.keys()].join(', ') || '无'}`);
};

const getMod = (name) => {
    const n = sanitizeModName(name);
    if (!n) return null;
    const mod = mods.get(n);
    if (!mod) throw new Error(`未找到插件: ${n}（已加载: ${[...mods.keys()].join(', ') || '无'}）`);
    return mod;
};

const normalizeModResult = (result) => {
    if (result == null) throw new Error('插件返回空结果');
    if (typeof result === 'string') {
        const url = result.trim();
        if (!url) throw new Error('插件返回空 URL');
        return { mediaUrl: url, refererUrl: null, meta: null };
    }
    if (typeof result === 'object') {
        const mediaUrl = (result.url || result.mediaUrl || '').toString().trim();
        if (!mediaUrl) throw new Error('插件返回对象中缺少 url/mediaUrl');
        const refererUrl = result.pageUrl || result.referer || result.refererUrl || null;
        return { mediaUrl, refererUrl, meta: result };
    }
    throw new Error(`插件返回了不支持的类型: ${typeof result}`);
};

const buildBasicHeaders = (refererUrl) => {
    const headers = {
        'User-Agent': DEFAULT_UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    if (refererUrl && /^https?:\/\//i.test(refererUrl)) {
        headers.Referer = refererUrl;
        try { headers.Origin = new URL(refererUrl).origin; } catch (e) {}
    }
    return headers;
};

const resolveByMod = async (modName, input, updateStatus) => {
    const mod = getMod(modName);
    updateStatus(`🔌 使用插件解析: ${mod.name}`);
    updateStatus(null, `🔌 插件 ${mod.name} 解析中...`);
    console.log(`[Mod] 调用 ${mod.name}.download(${JSON.stringify(String(input).slice(0, 120))})`);
    const raw = await mod.download(input);
    const parsed = normalizeModResult(raw);
    updateStatus(`🔌 插件 ${mod.name} 解析成功: ${parsed.mediaUrl.substring(0, 80)}...`);
    return parsed;
};

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const getDownloadProxy = () => (process.env.DOWNLOAD_PROXY || process.env.VIDEO_PROXY || '').trim();
const getProxyDomain = () => (process.env.PROXY_DOMAIN || '').trim();

const applyProxyDomain = (originalUrl) => {
    // 两个代理都允许为空：都为空则直连。
    // DOWNLOAD_PROXY 是真正 HTTP 代理，优先级最高；设置后不再使用 PROXY_DOMAIN 改写 URL，避免双代理冲突。
    if (getDownloadProxy() || !getProxyDomain() || !originalUrl) return originalUrl;
    const prefix = getProxyDomain().replace(/\/+$/, '') + '/';
    return prefix + originalUrl.replace('://', '/');
};

const formatAxiosError = (error, context = '') => {
    const lines = [];
    const add = (label, value) => {
        if (value !== undefined && value !== null && value !== '') lines.push(`${label}: ${value}`);
    };

    if (context) lines.push(context);
    add('name', error?.name);
    add('message', error?.message);
    add('code', error?.code);
    add('method', error?.config?.method?.toUpperCase());
    add('url', error?.config?.url);
    add('timeout', error?.config?.timeout);
    add('status', error?.response?.status);
    add('statusText', error?.response?.statusText);

    const cause = error?.cause;
    if (cause) {
        add('cause', `${cause.name || 'Error'}: ${cause.message || String(cause)}`);
        add('cause.code', cause.code);
        if (Array.isArray(cause.errors)) {
            cause.errors.forEach((inner, index) => {
                add(`cause.errors[${index}]`, `${inner.name || 'Error'}: ${inner.message || String(inner)}`);
                add(`cause.errors[${index}].code`, inner.code);
                add(`cause.errors[${index}].address`, inner.address);
                add(`cause.errors[${index}].port`, inner.port);
            });
        }
    }

    return lines.join('\n');
};

const PROGRESS_DEBOUNCE_MS = 5000;

const formatSpeed = (bytesPerSec) => {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0B/s';
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)}MB/s`;
    if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)}KB/s`;
    return `${Math.round(bytesPerSec)}B/s`;
};

const sameOrigin = (a, b) => {
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        return ua.protocol === ub.protocol && ua.host === ub.host;
    } catch (e) {
        return false;
    }
};

const stripCrossSiteHeaders = (headers = {}) => {
    const next = { ...headers };
    delete next.Referer;
    delete next.referer;
    delete next.Origin;
    delete next.origin;
    delete next.Cookie;
    delete next.cookie;
    return next;
};

const isRedirectStatus = (status) => [301, 302, 303, 307, 308].includes(status);

/**
 * 下载 MP4：手动跟随 302 中转链。
 * 跳转到跨站对象存储/网盘时剥离 Referer/Origin/Cookie，避免被 403。
 */
const downloadMp4WithRedirects = async (startUrl, headers, signal, proxy) => {
    let currentUrl = startUrl;
    let currentHeaders = { ...headers };
    const maxHops = 10;
    const hopLog = [];

    // 初始链接已是跨站（相对 Referer）时，首跳就剥离跨站头
    const initialReferer = currentHeaders.Referer || currentHeaders.referer;
    if (initialReferer && !sameOrigin(initialReferer, currentUrl)) {
        currentHeaders = stripCrossSiteHeaders(currentHeaders);
        hopLog.push(`init strip cross-site headers for ${currentUrl.substring(0, 80)}`);
    }

    for (let hop = 0; hop < maxHops; hop++) {
        const requestUrl = applyProxyDomain(currentUrl);
        let response;
        try {
            response = await axios({
                url: requestUrl,
                method: 'GET',
                responseType: 'stream',
                maxRedirects: 0,
                validateStatus: (status) => (status >= 200 && status < 400),
                signal,
                headers: currentHeaders,
                proxy: proxy || undefined
            });
        } catch (error) {
            // axios 在 maxRedirects:0 时，部分版本仍把 3xx 当成功；若走 error 且有 response 则继续处理
            if (error.response && isRedirectStatus(error.response.status)) {
                response = error.response;
            } else {
                console.error('[Axios Error] MP4请求失败\n' + formatAxiosError(error, `mediaUrl=${currentUrl} hop=${hop}`));
                throw error;
            }
        }

        if (isRedirectStatus(response.status)) {
            const location = response.headers?.location || response.headers?.Location;
            if (!location) {
                throw new Error(`MP4 重定向缺少 Location (status=${response.status})`);
            }
            // 丢弃 redirect body
            if (response.data && typeof response.data.destroy === 'function') {
                response.data.destroy();
            }

            const nextUrl = new URL(location, currentUrl).href;
            const crossSite = !sameOrigin(currentUrl, nextUrl);
            hopLog.push(`${response.status} -> ${nextUrl.substring(0, 80)}${crossSite ? ' [跨站,剥离Referer/Origin/Cookie]' : ''}`);

            if (crossSite) {
                currentHeaders = stripCrossSiteHeaders(currentHeaders);
            }
            currentUrl = nextUrl;
            continue;
        }

        if (hopLog.length) {
            console.log(`[MP4 Redirect] ${hopLog.join(' | ')}`);
        }
        return { response, finalUrl: currentUrl, hops: hopLog };
    }

    throw new Error(`MP4 重定向次数过多(>${maxHops})，可能存在循环跳转`);
};

const parseProxyUrl = () => {
    const raw = getDownloadProxy();
    if (!raw) return null;
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error('DOWNLOAD_PROXY 只支持 http/https 代理，例如 http://user:pass@host:port');
    }
    return u;
};

const getPlaywrightProxyConfig = () => {
    const u = parseProxyUrl();
    if (!u) return null;
    const cfg = { server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}` };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
};

const getAxiosProxyConfig = () => {
    const u = parseProxyUrl();
    if (!u) return null;
    const cfg = {
        protocol: u.protocol.slice(0, -1),
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    };
    if (u.username || u.password) {
        cfg.auth = {
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password)
        };
    }
    return cfg;
};

const buildDownloadHeaders = async (context, refererUrl, mediaUrl) => {
    let cookieHeader = '';
    try {
        const urls = [refererUrl, mediaUrl].filter(Boolean);
        const cookies = await context.cookies(urls);
        cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch (e) {}

    const headers = {
        'User-Agent': DEFAULT_UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': refererUrl,
        'Origin': new URL(refererUrl).origin
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
};

// === 全局异常保护 ===
process.on('unhandledRejection', (reason) => console.error('[Fatal] Promise拒绝:', reason));
process.on('uncaughtException', (err) => console.error('[Fatal] 进程异常:', err));

// === 日志拦截器 ===
let logBuffer = [];
const addToBuffer = (type, args) => {
    let msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    const isProgress = msg.includes('[进程]');
    const cleanMsg = msg.replace('[进程] ', '');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    if (isProgress) {
        if (logBuffer.length > 0 && logBuffer[logBuffer.length - 1].includes('⏳进度:')) {
            logBuffer[logBuffer.length - 1] = `[${time}] [${type}] ⏳进度: ${cleanMsg}`;
            return;
        }
        logBuffer.push(`[${time}] [${type}] ⏳进度: ${cleanMsg}`);
    } else {
        logBuffer.push(`[${time}] [${type}] ${cleanMsg}`);
    }
    if (logBuffer.length > 85) logBuffer.shift();
};
console.log = (...args) => { addToBuffer('INFO', args); process.stdout.write(args.join(' ') + '\n'); };
console.error = (...args) => { addToBuffer('ERROR', args); process.stderr.write(args.join(' ') + '\n'); };

// === 中间件配置 ===
app.use(express.json());
app.use(express.text({ type: '*/*' })); // 允许解析所有类型的文本输入
app.use(express.urlencoded({ extended: true }));
app.use('/dl', express.static(OUT_DIR));
// GET /log路径，可以直接获取日志
app.get('/log', (req, res) => {
    const logContent = [
        `=== 系统状态 ===`,
        `时间: ${new Date().toLocaleString()}`,
        `状态: ${serverState.isBusy ? '忙碌' : '空闲'}`,
        `任务: ${serverState.currentTask || '无'}`,
        `进度: ${serverState.progressStr || '无'}`,
        `\n=== 最近日志 ===`,
        ...logBuffer
    ].join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(logContent);
});


// === 全局状态 ===
let serverState = {
    isBusy: false,
    currentCode: null,
    currentTask: null,
    progressStr: null,
    abortController: null,
    ffmpegCommand: null,
    browser: null,
    res: null
};

// === 辅助函数 ===
const killAndReset = async () => {
    console.log('[System] 🗑 正在释放资源锁...');
    if (serverState.browser) { try { await serverState.browser.close(); } catch (e) {} }
    if (serverState.abortController) { try { serverState.abortController.abort(); } catch (e) {} }
    if (serverState.ffmpegCommand) { 
        try { if (typeof serverState.ffmpegCommand.kill === 'function') serverState.ffmpegCommand.kill('SIGKILL'); } catch (e) {} 
    }
    logBuffer = logBuffer.filter(line => !line.includes('⏳进度:'));
    serverState.isBusy = false;
    serverState.currentCode = null;
    serverState.currentTask = null;
    serverState.progressStr = null;
    serverState.abortController = null;
    serverState.ffmpegCommand = null;
    serverState.browser = null;
    if (serverState.res && !serverState.res.writableEnded) serverState.res.end();
    serverState.res = null;
};

const forceCleanFiles = async () => {
    const deletedFiles = [];
    try {
        const rootFiles = await fs.readdir(ROOT_DIR);
        for (const file of rootFiles) {
            const filePath = path.join(ROOT_DIR, file);
            if ((await fs.stat(filePath)).isFile()) { await fs.remove(filePath); deletedFiles.push(file); }
        }
        const outFiles = await fs.readdir(OUT_DIR);
        for (const file of outFiles) {
            const filePath = path.join(OUT_DIR, file);
            await fs.remove(filePath); deletedFiles.push(`out/${file}`);
        }
    } catch (e) {}
    return deletedFiles;
};

// === 核心处理逻辑 ===
const resolveMediaByBrowser = async (fullUrl, updateStatus) => {
    serverState.currentTask = '浏览器解析';
    updateStatus(null, "🌏 等待浏览器启动");

    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars'
        ]
    };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    const browserProxy = getPlaywrightProxyConfig();
    if (browserProxy) {
        launchOptions.proxy = browserProxy;
        updateStatus(null, '🛡 已启用下载代理，浏览器和下载使用同一出口IP');
    }

    const browser = await chromium.launch(launchOptions);
    serverState.browser = browser;

    let mediaUrl = null;
    let downloadHeaders = null;

    try {
        const UA = DEFAULT_UA;

        const context = await browser.newContext({
            userAgent: UA,
            viewport: { width: 1366, height: 768 },
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            deviceScaleFactor: 1,
            hasTouch: false,
            javaScriptEnabled: true,
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = window.chrome || { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        const page = await context.newPage();

        // 先挂监听，再 goto（关键）
        let foundBySniff = false;
        const findMediaPromise = new Promise((resolve) => {
            page.on('response', (response) => {
                if (foundBySniff) return;
                const url = response.url();
                const contentType = (response.headers()['content-type'] || '').toLowerCase();
                const resourceType = response.request().resourceType();

                const mediaResource =
                    resourceType === 'media' ||
                    url.split('?')[0].endsWith('.m3u8') ||
                    url.split('?')[0].endsWith('.mp4') ||
                    contentType.includes('application/vnd.apple.mpegurl') ||
                    contentType.includes('mpegurl') ||
                    contentType.includes('video/mp4') ||
                    contentType.includes('media');

                if (mediaResource) {
                    foundBySniff = true;
                    updateStatus(`🎯 嗅探命中: ${url.substring(0, 50)}...`);
                    resolve(url);
                }
            });
        });

        updateStatus(`🔗 打开页面: ${fullUrl}`);
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        await page.waitForTimeout(2500);

        const pageTitle = await page.title().catch(() => '未知标题');
        updateStatus(`📄 页面标题: ${pageTitle}`);

        // 快速 HTML 解析
        updateStatus('尝试直接解析HTML以快速获取链接...');
        let objectString = null;
        try {
            const htmlContent = await page.content();
            const regex = new RegExp("var player_aaaa\\s*=\\s*({[\\s\\S]*?})\\s*<\\/script>");
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                objectString = match[1];
                const playerData = eval('(' + objectString + ')');
                const url = playerData.url;

                if (url && url.startsWith('http') && (url.includes('.m3u8') || url.includes('.mp4'))) {
                    mediaUrl = url;
                    updateStatus(`🎯 快速命中: ${url.substring(0, 50)}...`);
                } else {
                    updateStatus('❕ 解析成功，但URL格式无效，继续等待网络嗅探。');
                }
            } else {
                updateStatus(null, '❕ 页面中未找到player_aaaa对象，继续等待网络嗅探。');
            }
        } catch (e) {
            let diagnosticMessage = `❕ 直接解析时出错: ${e.name}: ${e.message}`;
            if (objectString) {
                diagnosticMessage += `\n\n[调试信息] 解析失败片段(前200字符):\n${objectString.substring(0, 200)}`;
            } else {
                diagnosticMessage += `\n\n[调试信息] 正则未匹配到player_aaaa对象。`;
            }
            diagnosticMessage += "\n\n将继续网络监听。";
            updateStatus(diagnosticMessage);
        }

        // 如果快速解析没拿到，等嗅探结果
        if (!mediaUrl) {
            updateStatus('📡 等待网络监听命中媒体资源...');
            mediaUrl = await Promise.race([
                findMediaPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('嗅探超时')), 30000))
            ]);
        }

        downloadHeaders = await buildDownloadHeaders(context, fullUrl, mediaUrl);
        updateStatus(`🧩 下载指纹已同步: ${downloadHeaders.Cookie ? '含Cookie' : '无Cookie'}`);
        return { mediaUrl, downloadHeaders, refererUrl: fullUrl };
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
        serverState.browser = null;
    }
};

const processTask = async (urlFragment, file = null, code, res, modName = null) => {
    const isHttpUrl = typeof urlFragment === 'string' && /^https?:\/\//i.test(urlFragment);
    const requestedMod = modName ? sanitizeModName(modName) : null;

    // 默认 mgnacg 编号路径 / 显式插件 / 直接打开页面
    let fullUrl;
    if (isHttpUrl) {
        fullUrl = urlFragment;
    } else if (!requestedMod) {
        fullUrl = `https://www.mgnacg.com/bangumi/${urlFragment}`;
    } else {
        fullUrl = null; // 用户指定插件时，url 可能不是 http
    }

    let fileName;
    if (!file) {
        if (isHttpUrl) {
            try {
                const urlObj = new URL(urlFragment);
                const pathName = urlObj.pathname.split('/').pop() || 'video';
                fileName = `${code}_${pathName.replace(/[^a-z0-9]/gi, '_')}.mp4`;
            } catch (e) {
                fileName = `${code}_video.mp4`;
            }
        } else {
            const safe = String(urlFragment).replace(/[^a-z0-9._-]/gi, '_');
            fileName = `${safe || code}.mp4`;
        }
    } else {
        fileName = `${file}.mp4`;
    }

    const downloadPath = path.join(ROOT_DIR, fileName);
    const outPath = path.join(OUT_DIR, fileName);
    serverState.res = res;
    res.on('close', () => {
        if (serverState.res === res) {
            console.log(`[T ${code}] 客户端连接已断开，任务继续执行`);
            serverState.res = null; // 客户端断开后不再写入
        }
    });
    let logHistory = [];

    const updateStatus = (newLogMsg, dynamicStatus = "") => {
        if (newLogMsg) {
            logHistory.push(newLogMsg);
            console.log(`[T ${code}] ${newLogMsg}`);
        }
        if (dynamicStatus) {
            serverState.progressStr = dynamicStatus;
            console.log(`[进程] ${dynamicStatus}`);
        }
        if (serverState.res && !serverState.res.writableEnded && !serverState.res.destroyed) {
            const fullContent = logHistory.join('\n\n') + (dynamicStatus ? `\n\n ${dynamicStatus}` : '');
            serverState.res.write(JSON.stringify({ type: "msg", content: fullContent }) + '\n');
        }
    };

    try {
        updateStatus(`🚀 任务开始 (${code})`);
        if (requestedMod) {
            updateStatus(`🔌 任务指定插件: ${requestedMod}`);
        }

        let mediaUrl = null;
        let downloadHeaders = null;
        let refererUrl = fullUrl;

        // 1) 用户显式指定插件：只走插件，失败不回退浏览器
        if (requestedMod) {
            serverState.currentTask = `插件:${requestedMod}`;
            try {
                const resolved = await resolveByMod(requestedMod, urlFragment, updateStatus);
                mediaUrl = resolved.mediaUrl;
                refererUrl = resolved.refererUrl || refererUrl;
                downloadHeaders = buildBasicHeaders(refererUrl);
            } catch (e) {
                updateStatus(`❌ 插件 ${requestedMod} 解析失败: ${e.message || e}`);
                throw e;
            }
        } else if (!isHttpUrl) {
            // 2) 默认编号任务：优先 mgnacg 插件，失败再浏览器
            serverState.currentTask = '插件:mgnacg';
            if (mods.has('mgnacg')) {
                try {
                    updateStatus('🔌 默认任务优先使用插件 mgnacg 快速解析');
                    const resolved = await resolveByMod('mgnacg', urlFragment, updateStatus);
                    mediaUrl = resolved.mediaUrl;
                    refererUrl = resolved.refererUrl || fullUrl;
                    downloadHeaders = buildBasicHeaders(refererUrl);
                } catch (e) {
                    updateStatus(`⚠️ 插件 mgnacg 解析失败，回退浏览器抓取: ${e.message || e}`);
                    mediaUrl = null;
                }
            } else {
                updateStatus('⚠️ 未加载 mgnacg 插件，直接使用浏览器抓取');
            }

            if (!mediaUrl) {
                const browserResolved = await resolveMediaByBrowser(fullUrl, updateStatus);
                mediaUrl = browserResolved.mediaUrl;
                downloadHeaders = browserResolved.downloadHeaders;
                refererUrl = browserResolved.refererUrl || fullUrl;
            }
        } else {
            // 3) 直接传入 http 页面链接：浏览器抓取
            const browserResolved = await resolveMediaByBrowser(fullUrl, updateStatus);
            mediaUrl = browserResolved.mediaUrl;
            downloadHeaders = browserResolved.downloadHeaders;
            refererUrl = browserResolved.refererUrl || fullUrl;
        }

        if (!mediaUrl) {
            throw new Error("无法通过任何方式找到有效的视频链接。");
        }

        if (!/^https?:\/\//i.test(mediaUrl)) {
            throw new Error(`解析结果不是 http(s) 链接: ${String(mediaUrl).slice(0, 120)}`);
        }

        const headers = downloadHeaders || buildBasicHeaders(refererUrl);

                const isM3U8 = mediaUrl.includes('.m3u8');
        serverState.currentTask = isM3U8 ? 'M3U8下载' : 'MP4下载';
        serverState.abortController = new AbortController();

        // 下载前等待2秒
        updateStatus(null, '⏳ 下载前等待 2 秒...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (isM3U8) {
            updateStatus(`📦 M3U8 模式...`);
            await downloadM3U8(
                mediaUrl,
                downloadPath,
                (p, s, seg, speed) => {
                    const speedText = speed ? ` ${speed}` : '';
                    updateStatus(null, `📥 下载: ${p}% (${s}) [分片:${seg}]${speedText}`);
                },
                serverState,
                fullUrl,
                headers
            );
        } else {
            const writer = fs.createWriteStream(downloadPath);
            const { response, finalUrl, hops } = await downloadMp4WithRedirects(
                mediaUrl,
                headers,
                serverState.abortController.signal,
                getAxiosProxyConfig()
            );
            if (hops.length) {
                updateStatus(`🔀 跟随重定向 ${hops.length} 次: ${finalUrl.substring(0, 80)}...`);
            }

            const total = parseInt(response.headers['content-length'] || '0', 10);
            const totalMB = (total / 1024 / 1024).toFixed(2);

            let curr = 0;
            let lastBytes = 0;
            let lastT = Date.now();
            let lastReportT = 0;
            response.data.on('data', (c) => {
                curr += c.length;
                const now = Date.now();
                if (now - lastReportT < PROGRESS_DEBOUNCE_MS) return;

                const elapsed = Math.max(now - lastT, 1);
                const speed = formatSpeed((curr - lastBytes) * 1000 / elapsed);
                lastBytes = curr;
                lastT = now;
                lastReportT = now;

                const p = total ? Math.floor((curr / total) * 100) : 0;
                const currMB = (curr / 1024 / 1024).toFixed(2);
                updateStatus(null, `📥 下载: ${p}% (${currMB}/${totalMB}MB) ${speed}`);
            });

            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        }

        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `📦 压缩中...`);

        await new Promise((resolve, reject) => {
            const cmd = ffmpeg(downloadPath)
                .outputOptions([
                    '-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264',
                    '-crf', '17',
                    '-preset', 'medium',
                    '-c:a', 'copy'
                ])
                .save(outPath);

            serverState.ffmpegCommand = cmd;

            let lastCompressReportT = 0;
            cmd.on('progress', (p) => {
                const now = Date.now();
                if (now - lastCompressReportT < PROGRESS_DEBOUNCE_MS) return;
                lastCompressReportT = now;
                const outMB = (p.targetSize / 1024).toFixed(2);
                updateStatus(null, `📦 压缩: ${Math.floor(p.percent || 0)}% (${outMB}MB)`);
            });
            cmd.on('end', resolve);
            cmd.on('error', reject);
        });

        updateStatus("✅ 任务完成\n\n");
        if (!res.writableEnded) {
            res.write(JSON.stringify({
                type: "url",
                url: `https://${res.req.headers.host}/dl/${fileName}`
            }) + '\n');
        }
    } catch (error) {
        if (res && !res.writableEnded) {
            res.write(JSON.stringify({ type: "error", error: error.toString() }) + '\n');
        }
        console.error('[Task Error]', error?.stack || error?.message || error);
    } finally {
        await killAndReset();
    }
};

// === 路由入口 ===
app.post('/', async (req, res) => {
    // 1. 安全获取 body，防止 undefined 导致崩溃
    const body = req.body || {};
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // 2. 统一判断逻辑 (兼容字符串和对象)
    const isStr = typeof body === 'string';
    
    // 日志查询
    if (body === 'log' || body.log) {
        const logContent = [`=== 系统状态 ===`, `时间: ${new Date().toLocaleString()}`, `状态: ${serverState.isBusy ? '忙碌' : '空闲'}`, `\n=== 最近日志 ===`, ...logBuffer].join('\n');
        await fs.writeFile(path.join(OUT_DIR, 'log.txt'), logContent);
        res.write(JSON.stringify({ "type": "log", "log": `https://${req.headers.host}/dl/log.txt` }) + '\n');
        res.end(); return;
    }

    // 列表查询
    if (body === 'ls' || body.ls) {
        const files = await fs.readdir(OUT_DIR);
        res.write(JSON.stringify({ "type": "ls", "ls": files }) + '\n');
        res.end(); return;
    }

    // 停止或清理
    if (body === 'rm' || body.rm || body === 'stop' || body.stop) {
        const info = serverState.isBusy ? { code: serverState.currentCode, task: serverState.currentTask } : "无任务";
        await killAndReset();
        if (body === 'rm' || body.rm) {
            const deleted = await forceCleanFiles();
            res.write(JSON.stringify({ "type": "rm", "stop": info, "del": deleted }) + '\n');
        } else {
            res.write(JSON.stringify({ "type": "stop", "stop": info }) + '\n');
        }
        res.end(); return;
    }

    // 中止指定任务
    if (body.del) {
        const delCode = Number(body.del);
        if (serverState.isBusy && serverState.currentCode === delCode) {
            await killAndReset();
            res.write(JSON.stringify({ type: "msg", content: `任务 ${delCode} 已中止` }) + '\n');
        } else if (serverState.isBusy && serverState.currentCode != delCode) {
            const extraInfo = [
                serverState.currentTask ? `任务: ${serverState.currentTask}` : null,
                serverState.progressStr ? `进度: ${serverState.progressStr}` : null
            ].filter(Boolean).join('\n\n');

            const errorMsg = extraInfo
                ? `这不是你的任务：${serverState.currentCode}，无法终止\n\n${extraInfo}`
                : `这不是你的任务：${serverState.currentCode}，无法终止`;

            res.write(JSON.stringify({ type: "error", error: errorMsg }) + '\n');
        } else {
            res.write(JSON.stringify({ "type": "error",  error: "无任务运行" }) + '\n');
        }
        res.end(); return;
    }

    // 新建任务
    if (body.url && body.code) {
        if (serverState.isBusy) {
            const extraInfo = [
                serverState.currentTask ? `任务: ${serverState.currentTask}` : null,
                serverState.progressStr ? `进度: ${serverState.progressStr}` : null
            ].filter(Boolean).join('\n\n');

            const errorMsg = extraInfo
                ? `忙碌中: ${serverState.currentCode}\n\n${extraInfo}`
                : `忙碌中: ${serverState.currentCode}`;

            res.write(JSON.stringify({
                "type": "error",
                "error": errorMsg
            }) + '\n');
            res.end(); return;
        }
        // 可选 mod：插件文件名（不含 .js）；指定后 url 会原样传给插件 download()
        let modField = null;
        try {
            modField = body.mod ? sanitizeModName(body.mod) : null;
        } catch (e) {
            res.write(JSON.stringify({ type: "error", error: e.message || String(e) }) + '\n');
            res.end(); return;
        }
        if (modField && !mods.has(modField)) {
            res.write(JSON.stringify({
                type: "error",
                error: `未找到插件: ${modField}（已加载: ${[...mods.keys()].join(', ') || '无'}）`
            }) + '\n');
            res.end(); return;
        }

        serverState.isBusy = true;
        serverState.currentCode = Number(body.code);
        res.setTimeout(0); // 禁用响应超时，避免长任务中断
        processTask(body.url, body.file || null, serverState.currentCode, res, modField);
        return;
    }

    res.write(JSON.stringify({ "type": "error", "error": "无效请求参数" }) + '\n');
    res.end();
});

loadMods();
const server = app.listen(PORT, () => console.log(`=== 视频服务器启动于 ${PORT} ===`));
// 关闭默认超时，避免长下载/压缩导致连接被动断开
server.requestTimeout = 0;
server.headersTimeout = 0;
