const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

const proxyDomain = process.env.PROXY_DOMAIN;

// 新增：启动时打印代理配置，用于诊断
console.log(`[Proxy] 启动时读取到的 PROXY_DOMAIN: ${proxyDomain || '未设置或为空'}`);

function applyProxy(originalUrl) {
    if (!proxyDomain || !originalUrl) {
        return originalUrl;
    }
    const transformedUrl = originalUrl.replace('://', '/');
    return `${proxyDomain}${transformedUrl}`;
}

/**
 * M3U8 下载模块
 * (其余代码保持不变)
 */
async function downloadM3U8(m3u8Url, outputPath, onProgress, serverState, refererUrl) {
    const tempDir = path.join(path.dirname(outputPath), `m3u8_tmp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': refererUrl,
            'Origin': new URL(refererUrl).origin
        };

        let currentUrl = m3u8Url;
        let content = "";
        
        while (true) {
            const res = await axios.get(applyProxy(currentUrl), { headers, timeout: 10000 });
            content = res.data;
            if (content.includes('#EXT-X-STREAM-INF')) {
                const lines = content.split('\n');
                const subPath = lines.find(l => l && !l.startsWith('#'));
                if (!subPath) throw new Error("在M3U8中找不到子播放列表路径");
                currentUrl = new URL(subPath, currentUrl).href;
            } else {
                break;
            }
        }

        const tsLines = content.split('\n').filter(line => line && !line.startsWith('#'));
        const tsUrls = tsLines.map(line => applyProxy(new URL(line, currentUrl).href));
        const totalSegments = tsUrls.length;
        if (totalSegments === 0) throw new Error("未找到有效的 TS 分片");

        let downloadedCount = 0;
        let totalBytes = 0;
        let lastPercent = -1;
        let lastUpdateTime = 0;
        const CONCURRENCY = 8; 
        const ffmpegList = [];

        for (let i = 0; i < tsUrls.length; i += CONCURRENCY) {
            if (serverState.abortController?.signal.aborted) throw new Error("任务被中止");
            
            const chunk = tsUrls.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (url, index) => {
                const realIndex = i + index;
                const tsFileName = `seg_${String(realIndex).padStart(5, '0')}.ts`;
                const tsPath = path.join(tempDir, tsFileName);
                
                const response = await axios({ url, responseType: 'arraybuffer', headers, timeout: 30000 });
                await fs.writeFile(tsPath, response.data);
                
                totalBytes += response.data.length;
                downloadedCount++;
                ffmpegList[realIndex] = `file '${tsFileName}'`;

                const percent = Math.floor((downloadedCount / totalSegments) * 100);
                const now = Date.now();
                if (percent > lastPercent && (now - lastUpdateTime > 300)) {
                    lastPercent = percent;
                    lastUpdateTime = now;
                    const currMB = (totalBytes / 1024 / 1024).toFixed(2);
                    const segProgress = `${downloadedCount}/${totalSegments}`;
                    onProgress(percent, `${currMB}MB`, segProgress); 
                }
            }));
        }

        const fileListPath = path.join(tempDir, 'list.txt');
        await fs.writeFile(fileListPath, ffmpegList.join('\n'));
        
        const ffmpegPromise = new Promise((resolve, reject) => {
            const cmd = `ffmpeg -y -f concat -safe 0 -i "list.txt" -c copy -bsf:a aac_adtstoasc "${outputPath}"`;
            const proc = exec(cmd, { cwd: tempDir }, (err, stdout, stderr) => {
                if (err) {
                    err.message += `\n${stderr}`;
                    reject(err);
                } else {
                    resolve();
                }
            });
            serverState.ffmpegCommand = proc; 
        });

        await ffmpegPromise;

    } finally {
        await fs.remove(tempDir).catch(() => {});
    }
}

module.exports = { downloadM3U8 };