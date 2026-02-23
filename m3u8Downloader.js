const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

/**
 * M3U8 下载模块
 * @param {string} m3u8Url 原始URL
 * @param {string} outputPath 输出MP4路径
 * @param {function} onProgress 进度回调 (percent, sizeStr, segProgress)
 * @param {object} serverState 全局状态引用，用于挂载 ffmpeg 进程以便中止
 * @param {string} refererUrl 来源页面URL，用于伪装Referer请求头
 */
async function downloadM3U8(m3u8Url, outputPath, onProgress, serverState, refererUrl) {
    const tempDir = path.join(path.dirname(outputPath), `m3u8_tmp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    // 新增：伪装请求头，解决403 Forbidden问题
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': refererUrl
    };

    try {
        let currentUrl = m3u8Url;
        let content = "";
        
        // 1. 解析 M3U8 (处理嵌套)，并带上请求头
        while (true) {
            const res = await axios.get(currentUrl, { headers, timeout: 10000 });
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

        // 2. 提取 TS 链接
        const tsLines = content.split('\n').filter(line => line && !line.startsWith('#'));
        const tsUrls = tsLines.map(line => new URL(line, currentUrl).href);
        const totalSegments = tsUrls.length;
        if (totalSegments === 0) throw new Error("未找到有效的 TS 分片");

        // 3. 并发下载，并带上请求头
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
                const tsFileName = `seg_${String(realIndex).padStart(5, '0')}.ts`; // 补零确保ffmpeg排序正确
                const tsPath = path.join(tempDir, tsFileName);
                
                // 下载TS分片时也使用同样的请求头
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

        // 4. 生成合并列表
        const fileListPath = path.join(tempDir, 'list.txt');
        await fs.writeFile(fileListPath, ffmpegList.join('\n'));
        
        // 5. FFmpeg 合并
        return new Promise((resolve, reject) => {
            const cmd = `ffmpeg -y -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`;
            const proc = exec(cmd, { cwd: tempDir }, (err) => err ? reject(err) : resolve());
            serverState.ffmpegCommand = proc; 
        });

    } finally {
        await fs.remove(tempDir).catch(() => {});
    }
}

module.exports = { downloadM3U8 };