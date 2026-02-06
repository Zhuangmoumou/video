const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const { downloadM3u8 } = require('./m3u8Downloader');
const axios = require('axios'); // 用于直接下载 MP4

const app = express();
const PORT = 9898;

// === 路径配置 ===
const ROOT_DIR = path.join(process.cwd(), 'mp4');
const OUT_DIR = path.join(ROOT_DIR, 'out');
fs.ensureDirSync(ROOT_DIR);
fs.ensureDirSync(OUT_DIR);

// === 日志系统 (带缓冲区) ===
let logBuffer = [];
const addToBuffer = (type, args) => {
    let msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    const isProgress = msg.includes('[进程]');
    const cleanMsg = msg.replace('[进程] ', '');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    
    // 如果是进度条且上一条也是进度条，则覆盖（防止日志刷屏）
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
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => { addToBuffer('INFO', args); originalLog.apply(console, args); };
console.error = (...args) => { addToBuffer('ERROR', args); originalError.apply(console, args); };

// === 中间件 ===
app.use(express.json());
app.use(express.text({ type: 'text/plain' }));
app.use('/dl', express.static(OUT_DIR, {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
    }
}));

// === 全局状态 ===
let serverState = {
    isBusy: false,
    currentCode: null,
    currentTask: null,
    progressStr: null,
    abortController: null, // 用于 Axios/M3U8下载中止
    ffmpegCommand: null,   // 用于 FFmpeg 中止
    browser: null,         // Playwright 实例
    res: null
};

// === 资源清理与重置 ===
const killAndReset = async () => {
    console.log('[System] 🗑 正在执行清理...');
    
    // 1. 停止网络请求
    if (serverState.abortController) serverState.abortController.abort();
    
    // 2. 停止 FFmpeg
    if (serverState.ffmpegCommand) {
        try { serverState.ffmpegCommand.kill('SIGKILL'); } catch (e) {}
    }

    // 3. 关闭浏览器
    if (serverState.browser) {
        try { await serverState.browser.close(); } catch (e) {}
    }

    // 4. 重置状态
    logBuffer = logBuffer.filter(line => !line.includes('⏳进度:'));
    serverState.isBusy = false;
    serverState.currentCode = null;
    serverState.currentTask = null;
    serverState.progressStr = null;
    serverState.abortController = null;
    serverState.ffmpegCommand = null;
    serverState.browser = null;

    // 5. 结束 HTTP 响应
    if (serverState.res && !serverState.res.writableEnded) serverState.res.end();
    serverState.res = null;
};

// === 核心：Playwright 嗅探与下载任务 ===
const processTask = async (targetUrl, code, res) => {
    // 设置基础状态
    serverState.res = res;
    serverState.currentCode = code;
    serverState.abortController = new AbortController();
    let logHistory = [];

    // 状态更新辅助函数 (带节流)
    let lastUpdate = 0;
    const updateStatus = (newLogMsg, dynamicStatus = "", force = false) => {
        const now = Date.now();
        if (newLogMsg) { 
            logHistory.push(newLogMsg); 
            console.log(`[T ${code}] ${newLogMsg}`); 
        }
        if (dynamicStatus) { 
            serverState.progressStr = dynamicStatus;
            // 限制控制台打印频率
            if (force || now - lastUpdate > 2000) console.log(`[进程] ${dynamicStatus}`);
        }

        // 发送给客户端 (限制 500ms 频率，除非强制或有新日志)
        if (serverState.res && !serverState.res.writableEnded) {
            if (force || newLogMsg || (now - lastUpdate > 500)) {
                const fullContent = logHistory.join('\n\n') + (dynamicStatus ? `\n\n ${dynamicStatus}` : '');
                serverState.res.write(JSON.stringify({ content: fullContent }) + '\n');
                lastUpdate = now;
            }
        }
    };

    const fileName = `${code}.mp4`; // 简化文件名，直接用 code
    const downloadPath = path.join(ROOT_DIR, `raw_${fileName}`);
    const outPath = path.join(OUT_DIR, fileName);

    try {
        serverState.currentTask = '浏览器嗅探';
        updateStatus(`🚀 任务启动 (${code})`);
        updateStatus(`🌐 启动浏览器加载: ${targetUrl}`);

        // 1. 启动 Playwright
        const browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        serverState.browser = browser;
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // 2. 设置嗅探器
        let foundMediaUrl = null;
        let foundHeaders = {};
        
        // 监听请求以捕获 m3u8 或 mp4
        const waitForMedia = new Promise((resolve) => {
            page.on('request', request => {
                const url = request.url();
                const type = request.resourceType();
                // 简单的过滤逻辑
                if (url.includes('.m3u8') || url.includes('.mp4') || (type === 'media' && !url.includes('.mp3'))) {
                    // 排除一些广告或无效链接
                    if (url.includes('favicon') || url.length < 10) return;
                    
                    if (!foundMediaUrl) {
                        foundMediaUrl = url;
                        foundHeaders = request.headers();
                        console.log(`[Sniffer] 捕获资源: ${url}`);
                        resolve(url);
                    }
                }
            });
            // 30秒超时机制
            setTimeout(() => resolve(null), 30000);
        });

        // 3. 访问页面并获取标题
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const pageTitle = await page.title();
        updateStatus(`📄 页面标题: ${pageTitle}`);

        // 4. 等待嗅探结果
        updateStatus(`🕵️ 正在嗅探视频资源...`);
        // 尝试触发播放（可选，有时需要点击）
        try {
            await page.evaluate(() => {
                const videos = document.querySelectorAll('video');
                if (videos.length > 0) videos[0].play();
            });
        } catch (e) {}

        const mediaUrl = await waitForMedia;
        if (!mediaUrl) throw new Error('未能在页面中嗅探到有效的视频链接 (30s超时)');
        
        updateStatus(`🎬 锁定资源: ${mediaUrl.substring(0, 50)}...`);
        
        // 关闭浏览器以节省资源
        await browser.close();
        serverState.browser = null;

        // 5. 开始下载
        if (mediaUrl.includes('.m3u8')) {
            serverState.currentTask = 'M3U8下载';
            updateStatus(`📦 识别为 M3U8，启动分片下载引擎...`);
            
            await downloadM3u8(mediaUrl, downloadPath, {
                signal: serverState.abortController.signal,
                headers: { 
                    'User-Agent': foundHeaders['user-agent'] || 'Mozilla/5.0',
                    'Referer': targetUrl // 使用原网页作为 Referer
                },
                onProgress: (percent, msg, sizeStr) => {
                    // 这里进行 1% 变化检查和频率控制
                    updateStatus(null, `📥 下载进度: ${percent}% (${sizeStr})`);
                }
            });

        } else {
            serverState.currentTask = '直链下载';
            updateStatus(`📦 识别为 MP4 直链，开始下载...`);
            
            const writer = fs.createWriteStream(downloadPath);
            const response = await axios({
                url: mediaUrl,
                method: 'GET',
                responseType: 'stream',
                headers: { 
                    'User-Agent': foundHeaders['user-agent'] || 'Mozilla/5.0',
                    'Referer': targetUrl
                },
                signal: serverState.abortController.signal
            });

            const totalLength = parseInt(response.headers['content-length'] || '0', 10);
            let downloaded = 0;
            let lastPct = -1;
            
            response.data.on('data', (chunk) => {
                downloaded += chunk.length;
                const pct = totalLength ? Math.floor((downloaded / totalLength) * 100) : 0;
                if (pct !== lastPct) {
                    lastPct = pct;
                    const sizeMB = (downloaded / 1024 / 1024).toFixed(2);
                    updateStatus(null, `📥 下载进度: ${pct}% (${sizeMB} MB)`);
                }
            });
            
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                serverState.abortController.signal.addEventListener('abort', () => {
                    writer.destroy();
                    reject(new Error('中止'));
                });
            });
        }

        // 6. 压缩处理 (和之前一致)
        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `🔨 视频已就绪，开始压缩处理...`, true);
        
        await new Promise((resolve, reject) => {
            const command = ffmpeg(downloadPath)
                .outputOptions([
                    '-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2', 
                    '-c:v', 'libx264', 
                    '-crf', '17',       // 稍微调高crf加快速度
                    '-preset', 'slow', 
                    '-c:a', 'copy'      // 音频不转码
                ])
                .save(outPath);
            
            serverState.ffmpegCommand = command;
            
            let lastProg = -1;
            command.on('progress', (p) => {
                const prog = Math.floor(p.percent || 0);
                if (prog !== lastProg) {
                    lastProg = prog;
                    updateStatus(null, `📦 压缩处理: ${prog}%`);
                }
            });
            
            command.on('end', resolve);
            command.on('error', (err) => {
                if (err.message.includes('SIGKILL')) reject(new Error('中止'));
                else reject(err);
            });
        });

        // 7. 清理临时文件
        try { fs.unlinkSync(downloadPath); } catch (e) {}

        const downloadLink = `https://${res.req.headers.host}/dl/${fileName}`;
        updateStatus(`✅ 任务完成: ${pageTitle}`);
        if (!res.writableEnded) res.write(JSON.stringify({ "url": downloadLink }) + '\n');

    } catch (error) {
        if (error.message === '中止') {
            updateStatus(`⛔ 任务被用户中止`);
        } else {
            console.error(`[Task ${code}] Error:`, error);
            if (res && !res.writableEnded) res.write(JSON.stringify({ "error": error.message }) + '\n');
        }
    } finally {
        await killAndReset();
    }
};

// === 路由入口 ===
app.post('/', async (req, res) => {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // LOG
    if (body === 'log' || (body && body.log)) {
        const logContent = [`=== 系统状态 ===`, `状态: ${serverState.isBusy ? `忙碌 (${serverState.currentCode})` : '空闲'}`, `\n=== 日志 ===`, ...logBuffer].join('\n');
        try {
            await fs.writeFile(path.join(OUT_DIR, 'log.txt'), logContent);
            res.write(JSON.stringify({ "log": `https://${req.headers.host}/dl/log.txt` }) + '\n');
        } catch (e) { res.write(JSON.stringify({ "error": e.message }) + '\n'); }
        res.end();
        return;
    }

    // LS
    if (body === 'ls' || (body && body.ls)) {
        try { const files = await fs.readdir(OUT_DIR); res.write(JSON.stringify({ "ls": files }) + '\n'); } 
        catch (e) { res.write(JSON.stringify({ "error": e.message }) + '\n'); }
        res.end(); return;
    }

    // STOP (返回格式适配 index.js)
    if (body === 'stop' || (body && body.stop)) {
        if (serverState.isBusy) {
            const info = { task: serverState.currentTask, code: serverState.currentCode };
            await killAndReset();
            res.write(JSON.stringify({ "stop": info }) + '\n');
        } else {
            res.write(JSON.stringify({ "stop": "无任务" }) + '\n');
        }
        res.end(); return;
    }

    // RM (返回格式适配 index.js + 返回删除文件列表)
    if (body === 'rm' || (body && body.rm)) {
        await killAndReset();
        let deletedFiles = [];
        try {
            const files = await fs.readdir(OUT_DIR);
            deletedFiles = files;
            await fs.emptyDir(ROOT_DIR);
            await fs.ensureDir(OUT_DIR);
        } catch (e) {}
        
        // 这里的格式为了兼容 index.js: 
        // 客户端 index.js 逻辑: if (chunk.stop === "无任务") 显示 chunk.stop + 列表
        // 所以我们发送 stop: "无任务" 并在 del 字段放文件列表
        res.write(JSON.stringify({ "stop": "无任务", "del": deletedFiles }) + '\n');
        res.end(); return;
    }

    // DEL (指定 code)
    if (body && body.del) {
        const delCode = Number(body.del);
        if (serverState.isBusy && serverState.currentCode === delCode) {
            const info = { task: serverState.currentTask, code: serverState.currentCode };
            await killAndReset();
            res.write(JSON.stringify({ "stop": info }) + '\n');
        } else {
            res.write(JSON.stringify({ "error": "任务不在运行中" }) + '\n');
        }
        res.end(); return;
    }

    // NEW TASK
    if (body && body.url && body.code) {
        if (serverState.isBusy) {
            res.write(JSON.stringify({ "error": `服务器忙: ${serverState.currentCode} (${serverState.currentTask})` }) + '\n');
            res.end(); return;
        }
        serverState.isBusy = true;
        processTask(body.url, Number(body.code), res);
        return;
    }

    res.write(JSON.stringify({ "error": "无效参数" }) + '\n');
    res.end();
});

app.listen(PORT, () => console.log(`=== Video Server Started on ${PORT} ===`));