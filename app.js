const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process'); // 引入 spawn
const { downloadM3u8 } = require('./m3u8Downloader');

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
console.log = (...args) => { addToBuffer('INFO', args); process.stdout.write(args.join(' ') + '\n'); };
console.error = (...args) => { addToBuffer('ERROR', args); process.stderr.write(args.join(' ') + '\n'); };

// === 全局状态管理 ===
let serverState = {
    isBusy: false,
    currentCode: null,
    currentTask: null,
    progressStr: null,
    abortController: null,
    ffmpegCommand: null,
    wgetProcess: null, // 新增 wget 进程引用
    res: null
};

const killAndReset = async () => {
    console.log('[System] 🗑 正在执行清理并释放资源锁...');
    if (serverState.abortController) serverState.abortController.abort();
    if (serverState.ffmpegCommand) { try { serverState.ffmpegCommand.kill('SIGKILL'); } catch (e) {} }
    if (serverState.wgetProcess) { try { serverState.wgetProcess.kill('SIGKILL'); } catch (e) {} }
    logBuffer = logBuffer.filter(line => !line.includes('⏳进度:'));
    serverState.isBusy = false;
    serverState.currentCode = null;
    serverState.currentTask = null;
    serverState.progressStr = null;
    serverState.abortController = null;
    serverState.ffmpegCommand = null;
    serverState.wgetProcess = null;
    if (serverState.res && !serverState.res.writableEnded) serverState.res.end();
    serverState.res = null;
};

// === Wget 下载逻辑 ===
const downloadWithWget = (url, savePath, headers, onProgress, signal) => {
    return new Promise((resolve, reject) => {
        const args = [
            '--header', `Referer: ${headers.Referer || ''}`,
            '--header', `User-Agent: Mozilla/5.0`,
            '-O', savePath,
            '--progress=bar:force', // 强制输出进度条
            url
        ];

        const child = spawn('wget', args);
        serverState.wgetProcess = child;

        child.stderr.on('data', (data) => {
            const line = data.toString();
            // 解析百分比 (例如: 15%)
            const percentMatch = line.match(/(\d+)%/);
            // 解析已下载大小 (例如: 2.34M)
            const sizeMatch = line.match(/([\d.]+[KMG])/);

            if (percentMatch || sizeMatch) {
                const p = percentMatch ? `${percentMatch[1]}%` : '...';
                const s = sizeMatch ? sizeMatch[1] : '...';
                onProgress(p, s);
            }
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Wget 退出，代码: ${code}`));
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                child.kill('SIGKILL');
                reject(new Error('中止'));
            });
        }
    });
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
        const mediaUrl = JSON.parse(playerMatch[1]).url;
        updateStatus(`🎬 捕获到 URL: ${mediaUrl.substring(0, 60)}...`);

        if (mediaUrl.includes('.m3u8')) {
            serverState.currentTask = 'M3U8下载';
            updateStatus(`📦 检测到 M3U8，启动 FFmpeg 下载...`);
            await downloadM3u8(mediaUrl, downloadPath, {
                signal: serverState.abortController.signal,
                headers: { 'Referer': 'https://omofun01.xyz/' },
                onProgress: (p, s) => updateStatus(null, `📥 M3U8下载进度: ${p || '...'}% [已下载: ${s}]`)
            });
        } else {
            serverState.currentTask = 'Wget下载';
            updateStatus(`📥 检测到 MP4，启动 Wget 下载...`);
            await downloadWithWget(
                mediaUrl, 
                downloadPath, 
                { 'Referer': 'https://omofun01.xyz/' },
                (p, s) => updateStatus(null, `📥 Wget下载进度: ${p} [已下载: ${s}]`),
                serverState.abortController.signal
            );
        }

        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `📦 开始压缩处理...`);
        await new Promise((resolve, reject) => {
            const command = ffmpeg(downloadPath).outputOptions(['-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-c:a', 'copy']).save(outPath);
            serverState.ffmpegCommand = command;
            command.on('progress', (p) => updateStatus(null, `📦 压缩进度: ${Math.floor(p.percent || 0)}%`));
            command.on('end', resolve); command.on('error', reject);
        });

        const downloadUrl = `https://${res.req.headers.host}/dl/${fileName}`;
        updateStatus(`✅ 任务全部结束`);
        if (!res.writableEnded) res.write(JSON.stringify({ "url": downloadUrl }) + '\n');
    } catch (error) {
        if (error.name !== 'AbortError' && error.message !== '中止') {
            console.error(`[Task ${code}] 错误:`, error.message);
            if (res && !res.writableEnded) res.write(JSON.stringify({ "error": error.message }) + '\n');
        }
    } finally { await killAndReset(); }
};

// === 路由入口 (保持不变) ===
app.use(express.json());
app.use('/dl', express.static(OUT_DIR));

app.post('/', async (req, res) => {
    let body = req.body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // ... 逻辑判断 (log, ls, stop, rm, del) 保持不变 ...
    if (body && body.url && body.code) {
        const newCode = Number(body.code);
        if (serverState.isBusy) {
            res.write(JSON.stringify({ "error": "服务器忙" }) + '\n');
            res.end(); return;
        }
        serverState.isBusy = true;
        serverState.currentCode = newCode;
        processTask(body.url, newCode, res);
        return;
    }
    res.end();
});

app.listen(PORT, () => console.log(`=== OmoFun 服务器已启动 (端口: ${PORT}) ===`));