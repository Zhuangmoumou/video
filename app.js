const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { downloadM3u8 } = require('./m3u8Downloader'); // 导入新模块

const app = express();
const PORT = 9898;

// === 路径配置 ===
const ROOT_DIR = path.join(process.cwd(), 'mp4');
const OUT_DIR = path.join(ROOT_DIR, 'out');
fs.ensureDirSync(ROOT_DIR);
fs.ensureDirSync(OUT_DIR);

// === 日志拦截器 (保持不变) ===
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

// === 全局状态管理 ===
let serverState = {
    isBusy: false,
    currentCode: null,
    currentTask: null,
    progressStr: null,
    abortController: null,
    ffmpegCommand: null,
    res: null
};

const killAndReset = async () => {
    console.log('[System] 🗑 正在执行清理并释放资源锁...');
    if (serverState.abortController) serverState.abortController.abort();
    if (serverState.ffmpegCommand) { try { serverState.ffmpegCommand.kill('SIGKILL'); } catch (e) {} }
    logBuffer = logBuffer.filter(line => !line.includes('⏳进度:'));
    serverState.isBusy = false;
    serverState.currentCode = null;
    serverState.currentTask = null;
    serverState.progressStr = null;
    serverState.abortController = null;
    serverState.ffmpegCommand = null;
    if (serverState.res && !serverState.res.writableEnded) serverState.res.end();
    serverState.res = null;
};

const forceCleanFiles = async () => {
    try {
        await fs.emptyDir(ROOT_DIR);
        await fs.emptyDir(OUT_DIR);
    } catch (e) {}
    return ["All files cleaned"];
};


// === 核心处理逻辑 ===
const processTask = async (urlFragment, code, res) => {
    const parts = urlFragment.split('-');
    let vodId, sid, nid;
    if (parts.length === 3) [vodId, sid, nid] = parts;
    else if (parts.length === 2) { [vodId, nid] = parts; sid = '1'; }
    else {
        res.write(JSON.stringify({ "error": "格式错误" }) + '\n');
        res.end(); serverState.isBusy = false; return;
    }

    const playPageUrl = `https://dm.xifanacg.com/watch/${vodId}/${sid}/${nid}.html`;
    const fileName = `${urlFragment}.mp4`;
    const downloadPath = path.join(ROOT_DIR, fileName);
    const outPath = path.join(OUT_DIR, fileName);

    serverState.res = res; 
    serverState.abortController = new AbortController();
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
        serverState.currentTask = '解析页面';
        updateStatus(`🚀 任务开始 (${code})`);
        updateStatus(`🌐 正在请求播放页 (线路 ${sid}): ${playPageUrl}`);
        
        const { data: html } = await axios.get(playPageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000,
            signal: serverState.abortController.signal
        });

        const nameMatch = html.match(/var vod_name\s*=\s*'(.*?)'/);
        const partMatch = html.match(/var vod_part\s*=\s*'(.*?)'/);
        const videoTitle = `${nameMatch ? nameMatch[1] : '未知'} ${partMatch ? partMatch[1] : `第${nid}集`}`;
        updateStatus(`📄 视频标题: ${videoTitle}`);

        const playerMatch = html.match(/var player_aaaa\s*=\s*({.*?})<\/script>/);
        if (!playerMatch) throw new Error('未能提取到播放配置');
        
        let mediaUrl = JSON.parse(playerMatch[1]).url;

        // 【修改点 1】: 如果是 MP4 资源，替换 URL 协议头
        if (mediaUrl.toLowerCase().includes('.mp4')) {
            mediaUrl = mediaUrl.replace('https://', 'https://p.bsgm.us.kg/p/https/');
            updateStatus(`🔗 检测到 MP4，已应用代理: ${mediaUrl.substring(0, 60)}...`);
        } else {
            updateStatus(`🎬 捕获到 URL: ${mediaUrl.substring(0, 60)}...`);
        }

        if (mediaUrl.includes('.m3u8')) {
            serverState.currentTask = 'M3U8下载';
            updateStatus(`📦 检测到 M3U8，启动 FFmpeg 下载...`);
            
            // 【修改点 2】: 调用更新后的 downloadM3u8，传入进度和大小显示
            await downloadM3u8(mediaUrl, downloadPath, {
                signal: serverState.abortController.signal,
                headers: { 'Referer': 'https://omofun01.xyz/', 'User-Agent': 'Mozilla/5.0' },
                onProgress: (percent, size) => {
                    const progressText = percent ? `${percent}%` : '计算中...';
                    updateStatus(null, `📥 M3U8下载进度: ${progressText} [已下载: ${size}]`);
                }
            });
        } else {
            // MP4 下载逻辑保持不变
            serverState.currentTask = '视频下载';
            const writer = fs.createWriteStream(downloadPath);
            const response = await axios({ 
                url: mediaUrl, 
                method: 'GET', 
                responseType: 'stream', 
                signal: serverState.abortController.signal, 
                headers: { 'Referer': 'https://omofun01.xyz/' } 
            });
            const totalLength = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedLength = 0, lastPercent = -1;
            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                const currentPercent = totalLength ? Math.floor((downloadedLength / totalLength) * 100) : -1;
                const sizeMB = (downloadedLength / 1024 / 1024).toFixed(2);
                if (currentPercent !== lastPercent && currentPercent !== -1) { 
                    lastPercent = currentPercent; 
                    updateStatus(null, `📥 下载中: ${currentPercent}% [已下载: ${sizeMB}MB]`); 
                }
            });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                serverState.abortController.signal.addEventListener('abort', () => { writer.destroy(); reject(new Error('中止')); });
            });
        }

        // 后续 FFmpeg 压缩逻辑保持不变
        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `📦 开始压缩处理...`);
        await new Promise((resolve, reject) => {
            const command = ffmpeg(downloadPath)
                .outputOptions([
                    '-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2', 
                    '-c:v', 'libx264', 
                    '-crf', '17', 
                    '-preset', 'medium', 
                    '-c:a', 'copy'
                ])
                .save(outPath);
            serverState.ffmpegCommand = command;
            command.on('progress', (p) => updateStatus(null, `📦 压缩进度: ${Math.floor(p.percent || 0)}%`));
            command.on('end', resolve); 
            command.on('error', reject);
        });

        const downloadUrl = `https://${res.req.headers.host}/dl/${fileName}`;
        updateStatus(`✅ 任务全部结束`);
        if (!res.writableEnded) res.write(JSON.stringify({ "url": downloadUrl }) + '\n');
    } catch (error) {
        // ... 错误处理保持不变 ...
        if (error.name !== 'AbortError' && error.message !== '中止') {
            console.error(`[Task ${code}] 错误:`, error.message);
            if (res && !res.writableEnded) res.write(JSON.stringify({ "error": error.message }) + '\n');
        }
    } finally { await killAndReset(); }
};


// === 路由入口 (保持不变) ===
app.post('/', async (req, res) => {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    if (body === 'log' || (body && body.log)) {
        exec('sensors', async (error, stdout) => {
            let sensorsInfo = "N/A";
            if (!error && stdout) {
                const lines = stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const plusIdx = lastLine.indexOf('+');
                const cIdx = lastLine.indexOf('C', plusIdx);
                sensorsInfo = (plusIdx !== -1 && cIdx !== -1) ? lastLine.substring(plusIdx + 1, cIdx).trim() + "C" : "N/A";
            }
            const logContent = [`=== 系统状态 ===`, `时间: ${new Date().toLocaleString()}`, `温度: ${sensorsInfo}`, `状态: ${serverState.isBusy ? `忙碌 (${serverState.currentCode})` : '空闲'}`, `\n=== 最近日志 ===`, ...logBuffer].join('\n');
            try {
                await fs.writeFile(path.join(OUT_DIR, 'log.txt'), logContent, 'utf8');
                res.write(JSON.stringify({ "log": `https://${req.headers.host}/dl/log.txt` }) + '\n');
            } catch (err) { res.write(JSON.stringify({ "error": err.message }) + '\n'); }
            res.end();
        });
        return;
    }

    if (body === 'ls' || (body && body.ls)) {
        try { const files = await fs.readdir(OUT_DIR); res.write(JSON.stringify({ "ls": files }) + '\n'); } 
        catch (err) { res.write(JSON.stringify({ "error": err.message }) + '\n'); }
        res.end(); return;
    }

    if (body === 'stop' || (body && body.stop)) {
        await killAndReset();
        res.write(JSON.stringify({ "stop": "OK" }) + '\n');
        res.end(); return;
    }

    if (body === 'rm' || (body && body.rm)) {
        await killAndReset();
        await forceCleanFiles();
        res.write(JSON.stringify({ "rm": "OK" }) + '\n');
        res.end(); return;
    }

    if (body && body.del) {
        const delCode = Number(body.del);
        if (serverState.isBusy && serverState.currentCode === delCode) {
            await killAndReset();
            res.write(JSON.stringify({ success: `任务 ${delCode} 已中止` }) + '\n');
        } else {
            const statusInfo = serverState.isBusy ? `当前运行中任务: ${serverState.currentCode} [${serverState.currentTask}]${serverState.progressStr ? ` (${serverState.progressStr})` : ""}` : "当前无任务";
            res.write(JSON.stringify({ "error": `任务 ${delCode} 不在运行中\n\n${statusInfo}` }) + '\n');
        }
        res.end(); return;
    }

    if (body && body.url && body.code) {
        const newCode = Number(body.code);
        if (serverState.isBusy) {
            const statusInfo = `当前运行中任务: ${serverState.currentCode} [${serverState.currentTask}]${serverState.progressStr ? ` (${serverState.progressStr})` : ""}`;
            res.write(JSON.stringify({ "error": `服务器忙\n\n${statusInfo}` }) + '\n');
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

app.listen(PORT, () => console.log(`=== OmoFun 服务器已启动 (端口: ${PORT}) ===`));
