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

// === 辅助函数：清理资源锁 (不删文件) ===
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

// === 辅助函数：物理删除文件 ===
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
    const fullUrl = `https://www.mgnacg.com/bangumi/${urlFragment}`;
    const fileName = `${urlFragment}.mp4`;
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
        updateStatus(null, "🌏 正在打开浏览器");
        const browser = await chromium.launch({ headless: true });
        serverState.browser = browser;
        let mediaUrl = null;
        try {
            const page = await browser.newPage();
            updateStatus(`🌐 打开页面: ${fullUrl}`);
            const findMediaPromise = new Promise((resolve) => {
                page.on('response', (response) => {
                    const url = response.url();
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('video/mp4') || url.split('?')[0].endsWith('.mp4') || url.includes('.m3u8')) resolve(url);
                });
            });
            await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
            const pageTitle = await page.title().catch(() => '未知标题');
            updateStatus(`📄 页面标题: ${pageTitle}`); 
            mediaUrl = await Promise.race([findMediaPromise, new Promise((_, r) => setTimeout(() => r(new Error('嗅探超时')), 30000))]);
        } finally { await browser.close(); serverState.browser = null; }

        const isM3U8 = mediaUrl.includes('.m3u8');
        serverState.currentTask = isM3U8 ? 'M3U8下载' : 'MP4下载';
        serverState.abortController = new AbortController();

        if (isM3U8) {
            updateStatus(`📦 M3U8 模式...`);
            await downloadM3U8(mediaUrl, downloadPath, (p, s) => updateStatus(null, `📥 下载: ${p}% (${s})`), serverState);
        } else {
            const writer = fs.createWriteStream(downloadPath);
            const response = await axios({ url: mediaUrl, responseType: 'stream', signal: serverState.abortController.signal });
            const total = parseInt(response.headers['content-length'] || '0', 10);
            let curr = 0, lastP = -1, lastT = 0;

            response.data.on('data', (c) => {
                curr += c.length;
                const p = total ? Math.floor((curr / total) * 100) : 0;
                const now = Date.now();
                // MP4 下载进度节流：百分比增加 且 间隔 > 500ms
                if (p > lastP && (now - lastT > 500)) {
                    lastP = p; lastT = now;
                    updateStatus(null, `📥 下载: ${p}% (${(curr/1024/1024).toFixed(2)}MB)`);
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
            cmd.on('progress', (p) => updateStatus(null, `📦 压缩: ${Math.floor(p.percent || 0)}%`));
            cmd.on('end', resolve); cmd.on('error', reject);
        });
        updateStuatus("✅ 所有任务完成\n\n");
        if (!res.writableEnded) res.write(JSON.stringify({ "url": `https://${res.req.headers.host}/dl/${fileName}` }) + '\n');
    } catch (error) {
        if (res && !res.writableEnded) res.write(JSON.stringify({ "error": error.message }) + '\n');
    } finally { await killAndReset(); }
};

// === 路由入口 ===
app.use(express.json());
app.use('/dl', express.static(OUT_DIR));

app.post('/', async (req, res) => {
    const body = req.body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    if (body === 'log' || body.log) {
        const logContent = [`=== 系统状态 ===`, `时间: ${new Date().toLocaleString()}`, `状态: ${serverState.isBusy ? '忙碌' : '空闲'}`, `\n=== 最近日志 ===`, ...logBuffer].join('\n');
        await fs.writeFile(path.join(OUT_DIR, 'log.txt'), logContent);
        res.write(JSON.stringify({ "log": `https://${req.headers.host}/dl/log.txt` }) + '\n');
        res.end(); return;
    }

    if (body === 'ls' || body.ls) {
        const files = await fs.readdir(OUT_DIR);
        res.write(JSON.stringify({ "ls": files }) + '\n');
        res.end(); return;
    }

    if (body === 'rm' || body.rm || body === 'stop') {
        const info = serverState.isBusy ? { code: serverState.currentCode, task: serverState.currentTask } : "无任务";
        await killAndReset();
        if (body === 'rm' || body.rm) {
            const deleted = await forceCleanFiles();
            res.write(JSON.stringify({ "stop": info, "del": deleted }) + '\n');
        } else {
            res.write(JSON.stringify({ "stop": info, "note": "文件已保留" }) + '\n');
        }
        res.end(); return;
    }

    if (body.del) {
        if (serverState.isBusy && serverState.currentCode === Number(body.del)) {
            await killAndReset();
            res.write(JSON.stringify({ success: `任务 ${body.del} 已中止` }) + '\n');
        } else { res.write(JSON.stringify({ error: "任务未运行" }) + '\n'); }
        res.end(); return;
    }

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
    res.end(JSON.stringify({ "error": "无效请求" }));
});

app.listen(PORT, () => console.log(`=== Server Started on ${PORT} ===`));