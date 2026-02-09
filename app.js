const express = require('express');
const { chromium } = require('playwright');
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
fs.ensureDirSync(ROOT_DIR);
fs.ensureDirSync(OUT_DIR);

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
const processTask = async (urlFragment, code, res) => {
    let fullUrl;
    if (urlFragment.startsWith('http')) {
        fullUrl = urlFragment;
    } else {
        fullUrl = `https://www.mgnacg.com/bangumi/${urlFragment}`;
    }

    // 2. 安全生成文件名：
    // 如果是 URL，提取最后一段或使用 code 命名，防止非法字符导致保存失败
    let fileName;
    if (urlFragment.startsWith('http')) {
        // 提取 URL 中最后一段作为文件名，并过滤掉非法字符
        const urlObj = new URL(fullUrl);
        const pathName = urlObj.pathname.split('/').pop() || 'video';
        fileName = `${code}_${pathName.replace(/[^a-z0-9]/gi, '_')}.mp4`;
    } else {
        fileName = `${urlFragment}.mp4`;
    }
    const downloadPath = path.join(ROOT_DIR, fileName);
    const outPath = path.join(OUT_DIR, fileName);
    serverState.res = res; 
    let logHistory = [];

    const updateStatus = (newLogMsg, dynamicStatus = "") => {
        if (newLogMsg) { logHistory.push(newLogMsg); console.log(`[T ${code}] ${newLogMsg}`); }
        if (dynamicStatus) { serverState.progressStr = dynamicStatus; console.log(`[进程] ${dynamicStatus}`); }
        if (serverState.res && !serverState.res.writableEnded) {
            const fullContent = logHistory.join('\n\n') + (dynamicStatus ? `\n\n ${dynamicStatus}` : '');
            serverState.res.write(JSON.stringify({ content: fullContent }) + '\n');
        }
    };

    try {
        serverState.currentTask = '浏览器解析';
        updateStatus(`🚀 任务开始 (${code})`);
        updateStatus(null, "🌏 等待浏览器启动");
        const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars'] });
        serverState.browser = browser;
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
        });
        await context.addInitScript(() => {
            // 1. 屏蔽 Function 构造器中的 debugger
            const ArrayMethod = ["constructor", "toString"];
            const check = function () {
                return false;
            };
            
            // 劫持 Function 构造函数
            const oldFunctionConstructor = window.Function.prototype.constructor;
            window.Function.prototype.constructor = function (str) {
                if (str && str.indexOf('debugger') !== -1) {
                    // 如果包含 debugger，返回一个空函数
                    return function () {};
                }
                return oldFunctionConstructor.apply(this, arguments);
            };
        
            // 2. 屏蔽 eval 中的 debugger
            const oldEval = window.eval;
            window.eval = function (str) {
                if (str && str.indexOf('debugger') !== -1) {
                    return str.replace(/debugger/g, '');
                }
                return oldEval(str);
            };
        
            // 3. 针对某些网站通过 setInterval 运行 debugger 的情况
            const oldSetInterval = window.setInterval;
            window.setInterval = function (handler, timeout, ...args) {
                if (handler && handler.toString().indexOf('debugger') !== -1) {
                    return null;
                }
                return oldSetInterval(handler, timeout, ...args);
            };
        
            // 4. 伪装 Webdriver
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        let mediaUrl = null;
        try {
            const page = await context.newPage();
            updateStatus(`🔗 打开页面: ${fullUrl}`);
            const findMediaPromise = new Promise((resolve) => {
                page.on('response', (response) => {
                    const url = response.url();
                    const contentType = response.headers()['content-type'] || '';
                    // 获取 Playwright 的资源类型分类
                    const resourceType = response.request().resourceType();
                    // 调试 console.log(`[Debug] 资源: ${url.substring(0, 60)}... 类型: ${resourceType}`);
            
                    if (
                        resourceType === 'media' || contentType.includes('video/mp4') || url.split('?')[0].endsWith('.mp4') || url.includes('.m3u8') || contentType.includes('media')
                    ) {
                        updateStatus(`🎯 命中目标: ${url.substring(0, 50)}...`);
                        resolve(url);
                    }
                });
            });
            await page.goto(fullUrl, { waitUntil: 'load', timeout: 45000 });
            
            // 获取标题
            const pageTitle = await page.title().catch(() => '未知标题');
            updateStatus(`📄 页面标题: ${pageTitle}`);
            updateStatus(null, "尝试直接获取视频URL...");
            const directUrl = await page.evaluate(() => {
                // 尝试访问全局对象 player_aaaa
                if (typeof window.player_aaaa !== 'undefined' && window.player_aaaa !== null) {
                    const url = window.player_aaaa.url;
                    // 检查 url 是否存在且以 http 开头
                    if (typeof url === 'string' && url.startsWith('http')) {
                        return url;
                    }
                }
                return null; // 如果没有找到或不符合要求，返回 null
            }).catch(e => {
                console.error('[Playwright Eval Error]', e);
                return null; // 评估失败也返回 null
            });
    
            if (directUrl) {
                mediaUrl = directUrl;
                updateStatus(`⚡️ 成功通过 player_aaaa.url 获取到媒体URL!`);
                updateStatus(`🎯 目标URL: ${mediaUrl.substring(0, 50)}...`);
                // 此时 mediaUrl 已确定，跳过嗅探逻辑
            } else {
                updateStatus("🔍 未找到 player_aaaa.url 或 URL无效，回退到监听抓取...");
                updateStatus(null, "等待资源出现...");
    
                mediaUrl = await Promise.race([
                    findMediaPromise, 
                    new Promise((_, r) => setTimeout(() => r(new Error('嗅探超时')), 30000))
                ]);
            }
        } finally { await browser.close(); serverState.browser = null; }
        // 构造axios的请求头
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': fullUrl, 
            'Origin': new URL(fullUrl).origin
        };
        const isM3U8 = mediaUrl.includes('.m3u8');
        serverState.currentTask = isM3U8 ? 'M3U8下载' : 'MP4下载';
        serverState.abortController = new AbortController();

        if (isM3U8) {
            updateStatus(`📦 M3U8 模式...`);
            await downloadM3U8(mediaUrl, downloadPath, (p, s, seg) => {
                updateStatus(null, `📥 下载: ${p}% (${s}) [分片:${seg}]`);
            }, serverState);
        } else {
            const writer = fs.createWriteStream(downloadPath);
            const response = await axios({ url: mediaUrl, responseType: 'stream', signal: serverState.abortController.signal, headers: headers });
            
            // 1. 获取总字节数并转换为 MB
            const total = parseInt(response.headers['content-length'] || '0', 10);
            const totalMB = (total / 1024 / 1024).toFixed(2); 
            
            let curr = 0, lastP = -1, lastT = 0;
            
            response.data.on('data', (c) => {
                curr += c.length;
                const p = total ? Math.floor((curr / total) * 100) : 0;
                const now = Date.now();
                
                // 进度控制: 只有百分比变化且间隔超过 300ms 才更新，防止日志刷屏
                if (p > lastP && (now - lastT > 300)) {
                    lastP = p; 
                    lastT = now;
                    
                    // 2. 计算当前已下载的 MB
                    const currMB = (curr / 1024 / 1024).toFixed(2);
                    
                    // 3. 修改输出格式为：已下载/总大小
                    updateStatus(null, `📥 下载: ${p}% (${currMB}/${totalMB}MB)`);
                }
            });
            
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        }

        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `📦 压缩中...`);
        await new Promise((resolve, reject) => {
            const cmd = ffmpeg(downloadPath).outputOptions(['-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2','-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-c:a', 'copy']).save(outPath);
            serverState.ffmpegCommand = cmd;
            cmd.on('progress', (p) => {
                const outMB = (p.targetSize / 1024).toFixed(2); // 已输出的大小
                updateStatus(null, `📦 压缩: ${Math.floor(p.percent || 0)}% (${outMB}MB)`);
            });
            cmd.on('end', resolve); cmd.on('error', reject);
        });
        updateStatus("✅ 任务完成\n\n");
        if (!res.writableEnded) res.write(JSON.stringify({ "url": `https://${res.req.headers.host}/dl/${fileName}` }) + '\n');
    } catch (error) {
        if (res && !res.writableEnded) res.write(JSON.stringify({ "error": error.toString() }) + '\n');
        console.error('[Task Error]', error); 
    } finally { await killAndReset(); }
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
        res.write(JSON.stringify({ "log": `https://${req.headers.host}/dl/log.txt` }) + '\n');
        res.end(); return;
    }

    // 列表查询
    if (body === 'ls' || body.ls) {
        const files = await fs.readdir(OUT_DIR);
        res.write(JSON.stringify({ "ls": files }) + '\n');
        res.end(); return;
    }

    // 停止或清理
    if (body === 'rm' || body.rm || body === 'stop') {
        const info = serverState.isBusy ? { code: serverState.currentCode, task: serverState.currentTask } : "无任务";
        await killAndReset();
        if (body === 'rm' || body.rm) {
            const deleted = await forceCleanFiles();
            res.write(JSON.stringify({ "stop": info, "del": deleted }) + '\n');
        } else {
            res.write(JSON.stringify({ "stop": info }) + '\n');
        }
        res.end(); return;
    }

    // 中止指定任务
    if (body.del) {
        const delCode = Number(body.del);
        if (serverState.isBusy && serverState.currentCode === delCode) {
            await killAndReset();
            res.write(JSON.stringify({ success: `任务 ${delCode} 已中止` }) + '\n');
        } else if (serverState.isBusy && serverState.currentCode != delCode) {
            res.write(JSON.stringify({ error: `这不是你的任务：${serverState.currentCode}，无法终止\n\n进度：${serverState.currentTask}\n\n${serverState.progressStr}` }) + '\n');
        } else {
            res.write(JSON.stringify({ error: "无任务运行" }) + '\n');
        }
        res.end(); return;
    }

    // 新建任务
    if (body.url && body.code) {
        if (serverState.isBusy) {
            res.write(JSON.stringify({ "error": `忙碌中: ${serverState.currentCode}` }) + '\n');
            res.end(); return;
        }
        serverState.isBusy = true;
        serverState.currentCode = Number(body.code);
        processTask(body.url, serverState.currentCode, res);
        return;
    }

    res.write(JSON.stringify({ "error": "无效请求参数" }) + '\n');
    res.end();
});

app.listen(PORT, () => console.log(`=== 视频服务器启动于 ${PORT} ===`));
