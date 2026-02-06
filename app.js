const express = require('express');
const { chromium } = require('playwright');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = 9898;

// === 路径配置 ===
const ROOT_DIR = path.join(process.cwd(), 'mp4');
const OUT_DIR = path.join(ROOT_DIR, 'out');

fs.ensureDirSync(ROOT_DIR);
fs.ensureDirSync(OUT_DIR);

// === 日志拦截器 (支持进度替换与自动清理) ===
let logBuffer = [];
const addToBuffer = (type, args) => {
    let msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    const isProgress = msg.includes('[进程]');
    const cleanMsg = msg.replace('[进程] ', '');

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    if (isProgress) {
        // 如果最后一条也是进度，则直接替换，实现“单行显示”
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

console.log = (...args) => {
    addToBuffer('INFO', args);
    originalLog.apply(console, args);
};

console.error = (...args) => {
    addToBuffer('ERROR', args);
    originalError.apply(console, args);
};

// === 中间件 ===
app.use(express.json());
app.use(express.text());
app.use(express.urlencoded({ extended: true }));
app.use('/dl', express.static(OUT_DIR, {
    setHeaders: (res, path) => {
        res.setHeader('Access-Control-Allow-Origin', '*'); // 允许跨域
        res.setHeader('Cache-Control', 'public, max-age=3600'); // 允许客户端缓存
        res.setHeader('Accept-Ranges', 'bytes'); // 明确告知支持断点续传/多线程
    },
    maxAge: '1h',
    index: false
}));

// === 全局状态管理 ===
let serverState = {
    isBusy: false,
    currentCode: null,
    currentTask: null,
    progressStr: null, // 实时进度字符串
    abortController: null,
    ffmpegCommand: null,
    browser: null,
    res: null
};

// === 辅助函数：清理并重置 ===
const killAndReset = async () => {
    console.log('[System] 🗑 正在执行清理并释放资源锁...');
    
    // 物理中止
    if (serverState.browser) { try { await serverState.browser.close(); } catch (e) {} }
    if (serverState.abortController) { serverState.abortController.abort(); }
    if (serverState.ffmpegCommand) { try { serverState.ffmpegCommand.kill('SIGKILL'); } catch (e) {} }

    // 任务结束，从全局日志中删掉所有进度行，保持日志整洁
    logBuffer = logBuffer.filter(line => !line.includes('⏳进度:'));

    serverState.isBusy = false;
    serverState.currentCode = null;
    serverState.currentTask = null;
    serverState.progressStr = null;
    serverState.abortController = null;
    serverState.ffmpegCommand = null;
    serverState.browser = null;

    if (serverState.res && !serverState.res.writableEnded) {
        serverState.res.end();
    }
    serverState.res = null;
};

// === 辅助函数：清理物理文件 ===
const forceCleanFiles = async () => {
    const deletedFiles = [];
    try {
        const rootFiles = await fs.readdir(ROOT_DIR);
        for (const file of rootFiles) {
            const filePath = path.join(ROOT_DIR, file);
            if ((await fs.stat(filePath)).isFile()) {
                await fs.remove(filePath);
                deletedFiles.push(filePath);
            }
        }
        const outFiles = await fs.readdir(OUT_DIR);
        for (const file of outFiles) {
            const filePath = path.join(OUT_DIR, file);
            await fs.remove(filePath);
            deletedFiles.push(filePath);
        }
    } catch (e) {}
    return deletedFiles;
};


// === 全局异常捕获 (防止程序退出) ===
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Fatal] 未处理的 Promise 拒绝:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Fatal] 未捕获的异常:', err);
    // 可以在这里决定是否需要 killAndReset()
});

// === 辅助函数：清理并重置 (增强版) ===
const killAndReset = async () => {
    console.log('[System] 🗑 正在执行清理并释放资源锁...');
    
    try {
        // 1. 优先关闭浏览器
        if (serverState.browser) {
            await serverState.browser.close().catch(() => {});
        }
    } catch (e) {}

    // 2. 中止网络请求
    if (serverState.abortController) {
        try { serverState.abortController.abort(); } catch (e) {}
    }

    // 3. 杀死 FFmpeg
    if (serverState.ffmpegCommand) {
        try { serverState.ffmpegCommand.kill('SIGKILL'); } catch (e) {}
    }

    // 任务结束，清理进度日志
    logBuffer = logBuffer.filter(line => !line.includes('⏳进度:'));

    serverState.isBusy = false;
    serverState.currentCode = null;
    serverState.currentTask = null;
    serverState.progressStr = null;
    serverState.abortController = null;
    serverState.ffmpegCommand = null;
    serverState.browser = null;

    if (serverState.res && !serverState.res.writableEnded) {
        serverState.res.end();
    }
    serverState.res = null;
};

// === 核心处理逻辑 (重点修改部分) ===
const processTask = async (urlFragment, code, res) => {
    const fullUrl = `https://www.mgnacg.com/bangumi/${urlFragment}`;
    const fileName = `${urlFragment}.mp4`;
    const downloadPath = path.join(ROOT_DIR, fileName);
    const outPath = path.join(OUT_DIR, fileName);

    serverState.res = res; 
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
        if (serverState.res && !serverState.res.writableEnded) {
            const fullContent = logHistory.join('\n\n') + (dynamicStatus ? `\n\n ${dynamicStatus}` : '');
            serverState.res.write(JSON.stringify({ content: fullContent }) + '\n');
        }
    };

    try {
        serverState.currentTask = '浏览器解析';
        updateStatus(`🚀 任务开始 (${code})`);
        updateStatus(null, "🌏 正在启动无头浏览器...");
        
        const browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // 增加稳定性
        });
        serverState.browser = browser;

        let mediaUrl = null;

        // 使用内部 try-finally 确保浏览器一定会被关闭
        try {
            const page = await browser.newPage();
            updateStatus(`🌐 正在打开页面: ${fullUrl}`);
            
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('获取视频 URL 超时 (30s)')), 30000)
            );

            const findMediaPromise = new Promise((resolve) => {
                page.on('response', (response) => {
                    const url = response.url();
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('video/mp4') || url.split('?')[0].endsWith('.mp4')) {
                        resolve(url);
                    }
                });
            });

            // 导航增加错误捕获
            await page.goto(fullUrl, { 
                waitUntil: 'domcontentloaded', 
                timeout: 40000 // 增加到40秒
            }).catch(err => {
                throw new Error(`页面加载失败: ${err.message}`);
            });

            const pageTitle = await page.title().catch(() => '未知');
            updateStatus(`📄 页面标题: ${pageTitle}`);

            mediaUrl = await Promise.race([findMediaPromise, timeoutPromise]);
        } finally {
            // 无论解析成功还是失败，都关闭浏览器释放内存
            await browser.close();
            serverState.browser = null;
        }

        if (!mediaUrl) throw new Error("未能捕获到有效的视频地址");
        updateStatus(`🎬 捕获到视频 URL: ${mediaUrl.substring(0, 50)}...`);

        // --- 下载阶段 ---
        serverState.currentTask = '视频下载';
        serverState.abortController = new AbortController();
        
        const writer = fs.createWriteStream(downloadPath, { highWaterMark: 1024 * 1024 });
        const response = await axios({
            url: mediaUrl,
            method: 'GET',
            responseType: 'stream',
            signal: serverState.abortController.signal
        });

        const totalLength = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedLength = 0;
        let lastDownloadPercent = -1;

        response.data.on('data', (chunk) => {
            downloadedLength += chunk.length;
            const currentPercent = totalLength ? Math.floor((downloadedLength / totalLength) * 100) : 0;
            if (currentPercent !== lastDownloadPercent) {
                lastDownloadPercent = currentPercent;
                updateStatus(null, `📥 下载中: ${(downloadedLength / 1024 / 1024).toFixed(2)}MB / ${(totalLength / 1024 / 1024).toFixed(2)}MB (${currentPercent}%)`);
            }
        });

        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // --- 压缩阶段 ---
        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `📦 开始压缩处理...`);
        
        await new Promise((resolve, reject) => {
            const command = ffmpeg(downloadPath)
                .outputOptions([
                    '-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-c:a', 'copy'
                ])
                .save(outPath);

            serverState.ffmpegCommand = command;
            command.on('progress', (p) => {
                updateStatus(null, `📦 压缩处理: ${Math.floor(p.percent || 0)}%`);
            });
            command.on('end', resolve);
            command.on('error', (err) => reject(err));
        });

        const downloadUrl = `https://${res.req.headers.host}/dl/${fileName}`;
        updateStatus(`✅ 任务全部结束\n\n`);
        if (!res.writableEnded) res.write(JSON.stringify({ "url": downloadUrl }) + '\n');

    } catch (error) {
        const errorMsg = String(error.message || error);
        console.error(`[Task ${code}] 发生错误:`, errorMsg);
        if (res && !res.writableEnded) {
            res.write(JSON.stringify({ "error": errorMsg }) + '\n');
        }
    } finally {
        // 最终清理，确保 isBusy 被重置
        await killAndReset();
    }
};


// === 路由入口 ===
app.post('/', async (req, res) => {
    const body = req.body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // 1. 日志查询
    if (body === 'log' || body.log) {
        exec('sensors', async (error, stdout) => {
            let sensorsInfo = "Sensors: 获取失败";
            if (!error && stdout) {
                const lines = stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1]; // 获取最后一行
                
                const plusIdx = lastLine.indexOf('+');
                const cIdx = lastLine.indexOf('C', plusIdx);
                
                if (plusIdx !== -1 && cIdx !== -1 && cIdx > plusIdx) {
                    // 截取 + 到 C 之间的内容
                    sensorsInfo = lastLine.substring(plusIdx + 1, cIdx).trim() + "C";
                } else {
                    sensorsInfo = lastLine; // 如果没匹配到格式，回退到显示整行
                }
            }
            
            const logContent = [
                `=== 系统状态 ===`, 
                `时间: ${new Date().toLocaleString()}`, 
                `温度: ${sensorsInfo}`, 
                `状态: ${serverState.isBusy ? `忙碌 (${serverState.currentCode})` : '空闲'}`, 
                `\n=== 最近日志 ===`, 
                ...logBuffer
            ].join('\n');
    
            const logFileName = 'log.txt';
            try {
                await fs.writeFile(path.join(OUT_DIR, logFileName), logContent, 'utf8');
                res.write(JSON.stringify({ "log": `https://${req.headers.host}/dl/${logFileName}` }) + '\n');
            } catch (err) { 
                res.write(JSON.stringify({ "error": err.message }) + '\n'); 
            }
            res.end();
        });
        return;
    }

    // 2. 查询列表
    if (body === 'ls' || body.ls) {
        try {
            const files = await fs.readdir(OUT_DIR);
            res.write(JSON.stringify({ "ls": files }) + '\n');
        } catch (err) { res.write(JSON.stringify({ "error": String(err.message || err) }) + '\n'); }
        res.end(); return;
    }

    // 3. 停止或清理
    if (body === 'rm' || body.rm || body === 'stop') {
        let stopInfo = serverState.isBusy ? { task: serverState.currentTask, code: serverState.currentCode } : "无任务";
        await killAndReset();
        if (body === 'rm' || body.rm) {
            const deleted = await forceCleanFiles();
            res.write(JSON.stringify({ "stop": stopInfo, "del": deleted }) + '\n');
        } else { res.write(JSON.stringify({ "stop": stopInfo }) + '\n'); }
        res.end(); return;
    }

    // 4. 中止指定任务 (核心逻辑修改)
    if (body.del) {
        const delCode = Number(body.del);
        if (serverState.isBusy) {
            if (serverState.currentCode === delCode) {
                await killAndReset();
                res.write(JSON.stringify({ success: `任务 ${delCode} 已中止` }) + '\n');
            } else {
                // 增加运行中任务的状态返回
                const prog = serverState.progressStr ? ` (${serverState.progressStr})` : "";
                const currentStatus = `当前运行中任务: ${serverState.currentCode} [${serverState.currentTask}]${prog}`;
                res.write(JSON.stringify({ "error": `这不是你的任务，无法中止。\n\n${currentStatus}` }) + '\n');
            }
        } else {
            res.write(JSON.stringify({ "error": `任务 ${delCode} 不在运行中\n\n当前无任务。` }) + '\n');
        }
        res.end(); return;
    }

    // 5. 新建任务
    if (body.url && body.code) {
        const newCode = Number(body.code);
        if (serverState.isBusy) {
            const prog = serverState.progressStr ? ` (${serverState.progressStr})` : "";
            res.write(JSON.stringify({ "error": `服务器忙\n\n正在处理任务: ${serverState.currentCode} [${serverState.currentTask}]${prog}` }) + '\n');
            res.end(); return;
        }
        serverState.isBusy = true;
        serverState.currentCode = newCode;
        processTask(body.url, newCode, res);
        return;
    }

    res.write(JSON.stringify({ "error": "无效请求参数" }) + '\n');
    res.end();
});

app.listen(PORT, () => {
    console.log(`=== 视频处理服务器已启动 (端口: ${PORT}) ===`);
});
