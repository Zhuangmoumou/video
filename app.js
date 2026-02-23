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
const processTask = async (urlFragment, file = null, code, res) => {
    let fullUrl;
    if (urlFragment.startsWith('http')) {
        fullUrl = urlFragment;
    } else {
        fullUrl = `https://www.mgnacg.com/bangumi/${urlFragment}`;
    }

    // 2. 安全生成文件名：
    // 如果是 URL 且未传入文件名，提取最后一段或使用 code 命名，防止非法字符导致保存失败
    let fileName;
    if (!file) {
        if (urlFragment.startsWith('http')) {
            // 提取 URL 中最后一段作为文件名，并过滤掉非法字符
            const urlObj = new URL(fullUrl);
            const pathName = urlObj.pathname.split('/').pop() || 'video';
            fileName = `${code}_${pathName.replace(/[^a-z0-9]/gi, '_')}.mp4`;
        } else {
            fileName = `${urlFragment}.mp4`;
        }
    } else {
        fileName = `${file}.mp4`;
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
            serverState.res.write(JSON.stringify({ type: "msg", content: fullContent }) + '\n');
        }
    };

    try {
        serverState.currentTask = '浏览器解析';
        updateStatus(`🚀 任务开始 (${code})`);
        updateStatus(null, "🌏 等待浏览器启动");
        const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars'] });
        serverState.browser = browser;
        
        let mediaUrl = null;

        try {
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
            });
            const page = await context.newPage();
            updateStatus(`🔗 打开页面: ${fullUrl}`);
            await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            
            const pageTitle = await page.title().catch(() => '未知标题');
            updateStatus(`📄 页面标题: ${pageTitle}`);

            // === 最终修复：更精确的正则表达式和详细的错误诊断 ===
            updateStatus('⚡ 尝试直接解析HTML以快速获取链接...');
            let objectString = null; // 用于存储匹配到的对象字符串，以便调试
            try {
                const htmlContent = await page.content();
                // 更精确的正则表达式:
                // 匹配从 "var player_aaaa = {" 开始，到第一个 "}" 结束，并且后面紧跟着 "</script>"
                // 这能确保我们不会错误地匹配到页面其他地方的内容
                const regex = new RegExp("var player_aaaa\\s*=\\s*({[\\s\\S]*?})\\s*<\/script>");
                const match = htmlContent.match(regex);
                
                if (match && match[1]) {
                    objectString = match[1]; // 获取匹配的组
                    
                    const playerData = eval('(' + objectString + ')');
                    const url = playerData.url;

                    if (url && url.startsWith('http') && (url.endsWith('.m3u8') || url.endsWith('.mp4'))) {
                        mediaUrl = url;
                        updateStatus(`🎯 快速命中: ${url.substring(0, 90)}...`);
                    } else {
                        updateStatus('🟡 解析成功，但URL格式无效，将回退到网络监听。');
                    }
                } else {
                    updateStatus('🟡 页面中未找到player_aaaa对象，将回退到网络监听。');
                }
            } catch (e) {
                // 提供非常详细的错误诊断信息
                let errorType = e.name; // e.g., "SyntaxError"
                let errorMessage = e.message; // e.g., "Unexpected token"
                
                let diagnosticMessage = `🟡 直接解析时出错: ${errorType}: ${errorMessage}`;
                
                // 如果我们成功提取了字符串但eval失败了，就把这个字符串片段包含在日志里
                if (objectString) {
                    diagnosticMessage += `\n\n[调试信息] 解析失败的文本片段(前200字符):\n${objectString.substring(0, 200)}`;
                } else {
                    diagnosticMessage += `\n\n[调试信息] 正则表达式未能从HTML中匹配到player_aaaa对象。`;
                }
                
                diagnosticMessage += "\n\n将回退到网络监听。";
                updateStatus(diagnosticMessage);
            }
            // === 修复结束 ===

            if (!mediaUrl) {
                updateStatus('📡 启动网络监听以嗅探链接...');
                updateStatus(null, "等待资源出现...");
                let found = false;
                const findMediaPromise = new Promise((resolve) => {
                    page.on('response', (response) => {
                        if (found) return;
                        const url = response.url();
                        const contentType = response.headers()['content-type'] || '';
                        const resourceType = response.request().resourceType();
                        const mediaResource = resourceType === 'media' || url.split('?')[0].endsWith('.m3u8') || contentType.includes('video/mp4') || contentType.includes('media') || url.split('?')[0].endsWith('.mp4');
                        
                        if (mediaResource) {
                            found = true;
                            updateStatus(`🎯 嗅探命中: ${url.substring(0, 90)}...`);
                            resolve(url);
                        }
                    });
                });
                mediaUrl = await Promise.race([
                    findMediaPromise, 
                    new Promise((_, r) => setTimeout(() => r(new Error('嗅探超时')), 30000))
                ]);
            }
        } finally { 
            if (browser) { await browser.close(); }
            serverState.browser = null; 
        }

        if (!mediaUrl) {
            throw new Error("无法通过任何方式找到有效的视频链接。");
        }
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
            
            const total = parseInt(response.headers['content-length'] || '0', 10);
            const totalMB = (total / 1024 / 1024).toFixed(2); 
            
            let curr = 0, lastP = -1, lastT = 0;
            
            response.data.on('data', (c) => {
                curr += c.length;
                const p = total ? Math.floor((curr / total) * 100) : 0;
                const now = Date.now();
                
                if (p > lastP && (now - lastT > 300)) {
                    lastP = p; 
                    lastT = now;
                    const currMB = (curr / 1024 / 1024).toFixed(2);
                    updateStatus(null, `📥 下载: ${p}% (${currMB}/${totalMB}MB)`);
                }
            });
            
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        }

        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `📦 压缩中...`);
        await new Promise((resolve, reject) => {
            const cmd = ffmpeg(downloadPath).outputOptions(['-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2','-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-c:a', 'copy']).save(outPath);
            serverState.ffmpegCommand = cmd;
            cmd.on('progress', (p) => {
                const outMB = (p.targetSize / 1024).toFixed(2);
                updateStatus(null, `📦 压缩: ${Math.floor(p.percent || 0)}% (${outMB}MB)`);
            });
            cmd.on('end', resolve); cmd.on('error', reject);
        });
        updateStatus("✅ 任务完成\n\n");
        if (!res.writableEnded) res.write(JSON.stringify({ "type": "url", "url": `https://${res.req.headers.host}/dl/${fileName}` }) + '\n');
    } catch (error) {
        if (res && !res.writableEnded) res.write(JSON.stringify({ "type": "error", "error": error.toString() }) + '\n');
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
    if (body === 'rm' || body.rm || body === 'stop') {
        const info = serverState.isBusy ? { code: serverState.currentCode, task: serverState.currentTask } : "无任务";
        await killAndReset();
        if (body === 'rm' || body.rm) {
            const deleted = await forceCleanFiles();
            res.write(JSON.stringify({ "type": "stop", "stop": info, "del": deleted }) + '\n');
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
            res.write(JSON.stringify({ type: "error", error: `这不是你的任务：${serverState.currentCode}，无法终止\n\n进度：${serverState.currentTask}\n\n${serverState.progressStr}` }) + '\n');
        } else {
            res.write(JSON.stringify({ "type": "error",  error: "无任务运行" }) + '\n');
        }
        res.end(); return;
    }

    // 新建任务
    if (body.url && body.code) {
        if (serverState.isBusy) {
            res.write(JSON.stringify({ "type": "error", "error": `忙碌中: ${serverState.currentCode}` }) + '\n');
            res.end(); return;
        }
        serverState.isBusy = true;
        serverState.currentCode = Number(body.code);
        processTask(body.url, body.file || null, serverState.currentCode, res);
        return;
    }

    res.write(JSON.stringify({ "type": "error", "error": "无效请求参数" }) + '\n');
    res.end();
});

app.listen(PORT, () => console.log(`=== 视频服务器启动于 ${PORT} ===`));
