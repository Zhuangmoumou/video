const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');

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

// === 中件间 ===
app.use(express.json());
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
    m3u8Process: null, // 新增：用于管理 M3U8 下载进程
    res: null
};

// === 辅助函数：清理并重置 (打断逻辑) ===
const killAndReset = async () => {
    console.log('[System] 🗑 正在执行清理并释放资源锁...');
    if (serverState.abortController) serverState.abortController.abort();
    if (serverState.m3u8Process) {
        try { serverState.m3u8Process.kill('SIGKILL'); } catch (e) {}
    }
    if (serverState.ffmpegCommand) {
        try { serverState.ffmpegCommand.kill('SIGKILL'); } catch (e) {}
    }
    logBuffer = logBuffer.filter(line => !line.includes('⏳进度:'));
    serverState.isBusy = false;
    serverState.currentCode = null;
    serverState.currentTask = null;
    serverState.progressStr = null;
    serverState.abortController = null;
    serverState.ffmpegCommand = null;
    serverState.m3u8Process = null;
    if (serverState.res && !serverState.res.writableEnded) serverState.res.end();
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

// === 核心处理逻辑 ===
const processTask = async (urlFragment, code, res) => {
    const [vodId, nid] = urlFragment.split('-');
    if (!vodId || !nid) {
        res.write(JSON.stringify({ "error": "格式错误" }) + '\n');
        res.end();
        serverState.isBusy = false;
        return;
    }

    const playPageUrl = `https://omofun01.xyz/vod/play/id/${vodId}/sid/5/nid/${nid}.html`;
    const fileName = `${urlFragment}.mp4`;
    const downloadPath = path.join(ROOT_DIR, fileName);
    const outPath = path.join(OUT_DIR, fileName);

    serverState.res = res; 
    serverState.abortController = new AbortController();
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
        // --- 1. 解析页面 ---
        serverState.currentTask = '解析页面';
        updateStatus(`🚀 任务开始 (${code})`);
        
        const { data: html } = await axios.get(playPageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            timeout: 15000,
            signal: serverState.abortController.signal
        });

        const nameMatch = html.match(/var vod_name\s*=\s*'(.*?)'/);
        const partMatch = html.match(/var vod_part\s*=\s*'(.*?)'/);
        const animeName = nameMatch ? nameMatch[1] : '未知番剧';
        const episodePart = partMatch ? partMatch[1] : `第${nid}集`;
        const videoTitle = `${animeName} ${episodePart}`;
        updateStatus(`📄 视频标题: ${videoTitle}`);

        const playerMatch = html.match(/var player_aaaa\s*=\s*({.*?})<\/script>/);
        if (!playerMatch) throw new Error('未能提取到播放配置');
        const mediaUrl = JSON.parse(playerMatch[1]).url;
        updateStatus(`🎬 捕获到 URL: ${mediaUrl.substring(0, 60)}...`);

        // --- 2. 视频下载 (自动识别 MP4 或 M3U8) ---
        if (mediaUrl.includes('.m3u8')) {
            // === M3U8 下载逻辑 ===
            serverState.currentTask = 'M3U8下载';
            updateStatus(`📦 检测到 M3U8 格式，启动多线程下载...`);

            await new Promise((resolve, reject) => {
                // 使用 spawn 调用 m3u8-dl 命令行工具
                const m3u8dl = spawn('npx', [
                    '@lzwme/m3u8-dl', 
                    mediaUrl, 
                    '--saveDir', ROOT_DIR, 
                    '--saveName', urlFragment, // 库会自动处理后缀
                    '--headers', 'Referer:https://omofun01.xyz/'
                ]);

                serverState.m3u8Process = m3u8dl;

                let lastM3u8Percent = -1;
                m3u8dl.stdout.on('data', (data) => {
                    const str = data.toString();
                    // 匹配进度百分比，例如 "25.5%"
                    const match = str.match(/(\d+\.?\d*)%/);
                    if (match) {
                        const percent = Math.floor(parseFloat(match[1]));
                        if (percent !== lastM3u8Percent) {
                            lastM3u8Percent = percent;
                            updateStatus(null, `📥 M3U8下载进度: ${percent}%`);
                        }
                    }
                });

                m3u8dl.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`M3U8 下载失败，退出码: ${code}`));
                });

                m3u8dl.on('error', reject);

                // 监听打断信号
                serverState.abortController.signal.addEventListener('abort', () => {
                    m3u8dl.kill('SIGKILL');
                    reject(new Error('任务被用户中止'));
                });
            });
        } else {
            // === 原有 MP4 下载逻辑 ===
            serverState.currentTask = '视频下载';
            const writer = fs.createWriteStream(downloadPath, { highWaterMark: 1024 * 1024 });
            const response = await axios({
                url: mediaUrl, method: 'GET', responseType: 'stream',
                signal: serverState.abortController.signal,
                headers: { 'Referer': 'https://omofun01.xyz/', 'User-Agent': 'Mozilla/5.0' }
            });

            const totalLength = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedLength = 0;
            let lastPercent = -1;

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                const currentPercent = totalLength ? Math.floor((downloadedLength / totalLength) * 100) : -1;
                if (currentPercent !== lastPercent && currentPercent !== -1) {
                    lastPercent = currentPercent;
                    updateStatus(null, `📥 下载中: ${currentPercent}%`);
                }
            });

            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                serverState.abortController.signal.addEventListener('abort', () => {
                    writer.destroy(); reject(new Error('任务被用户中止'));
                });
            });
        }

        // --- 3. FFmpeg 压缩 ---
        serverState.currentTask = 'FFmpeg压缩';
        updateStatus(null, `📦 开始压缩处理...`);
        
        await new Promise((resolve, reject) => {
            const command = ffmpeg(downloadPath)
                .outputOptions([
                    '-vf', 'scale=320:170:force_original_aspect_ratio=decrease,pad=320:170:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-c:a', 'copy'
                ])
                .save(outPath);

            serverState.ffmpegCommand = command;
            command.on('progress', (p) => updateStatus(null, `📦 压缩进度: ${Math.floor(p.percent || 0)}%`));
            command.on('end', resolve);
            command.on('error', (err) => reject(err));
        });

        const downloadUrl = `https://${res.req.headers.host}/dl/${fileName}`;
        updateStatus(`✅ 任务全部结束`);
        if (!res.writableEnded) res.write(JSON.stringify({ "url": downloadUrl, "title": videoTitle }) + '\n');

    } catch (error) {
        if (axios.isCancel(error) || error.message === '任务被用户中止') {
            console.log(`[Task ${code}] 任务已物理中止。`);
        } else {
            const errorMsg = String(error.message || error);
            console.error(`[Task ${code}] 发生错误:`, errorMsg);
            if (res && !res.writableEnded) res.write(JSON.stringify({ "error": errorMsg }) + '\n');
        }
    } finally {
        await killAndReset();
    }
};

// === 路由入口 (保持不变) ===
app.post('/', async (req, res) => {
    const body = req.body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    if (body === 'log' || body.log) {
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

    if (body === 'ls' || body.ls) {
        try { const files = await fs.readdir(OUT_DIR); res.write(JSON.stringify({ "ls": files }) + '\n'); } 
        catch (err) { res.write(JSON.stringify({ "error": err.message }) + '\n'); }
        res.end(); return;
    }

    if (body === 'stop' || body.stop) {
        let stopInfo = serverState.isBusy ? { task: serverState.currentTask, code: serverState.currentCode } : "无任务";
        await killAndReset();
        res.write(JSON.stringify({ "stop": stopInfo }) + '\n');
        res.end(); return;
    }

    if (body === 'rm' || body.rm) {
        let stopInfo = serverState.isBusy ? { task: serverState.currentTask, code: serverState.currentCode } : "无任务";
        await killAndReset();
        const deleted = await forceCleanFiles();
        res.write(JSON.stringify({ "stop": stopInfo, "del": deleted }) + '\n');
        res.end(); return;
    }

    if (body.del) {
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

    if (body.url && body.code) {
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