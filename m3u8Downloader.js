const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

/**
 * M3U8 下载模块
 * @param {string} m3u8Url 原始URL
 * @param {string} outputPath 输出MP4路径
 * @param {function} onProgress 进度回调 (percent, sizeStr)
 * @param {object} serverState 全局状态引用，用于挂载 ffmpeg 进程以便中止
 */
async function downloadM3U8(m3u8Url, outputPath, onProgress, serverState) {
    const tempDir = path.join(path.dirname(outputPath), `m3u8_tmp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    try {
        let currentUrl = m3u8Url;
        let content = "";
        
        // 1. 解析 M3U8 (处理嵌套)
        while (true) {
            const res = await axios.get(currentUrl, { timeout: 10000 });
            content = res.data;
            if (content.includes('#EXT-X-STREAM-INF')) {
                const lines = content.split('\n');
                const subPath = lines.find(l => l && !l.startsWith('#'));
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

        // 3. 并发下载
        let downloadedCount = 0;
        let totalBytes = 0;
        let lastPercent = -1;
        let lastUpdateTime = 0;
        const CONCURRENCY = 8; 
        const ffmpegList = [];

        for (let i = 0; i < tsUrls.length; i += CONCURRENCY) {
            // 检查是否被外部中止
            if (serverState.abortController?.signal.aborted) throw new Error("任务被中止");
            
            const chunk = tsUrls.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (url, index) => {
                const realIndex = i + index;
                const tsFileName = `seg_${realIndex}.ts`;
                const tsPath = path.join(tempDir, tsFileName);
                
                const response = await axios({ url, responseType: 'arraybuffer', timeout: 30000 });
                await fs.writeFile(tsPath, response.data);
                
                totalBytes += response.data.length;
                downloadedCount++;
                ffmpegList[realIndex] = `file '${tsFileName}'`;

                // 进度控制: 1% 精度, 500ms 频率
                const percent = Math.floor((downloadedCount / totalSegments) * 100);
                const now = Date.now();
                if (percent > lastPercent && (now - lastUpdateTime > 500)) {
                    lastPercent = percent;
                    lastUpdateTime = now;
                    const currMB = (totalBytes / 1024 / 1024).toFixed(2);
                    const segProgress = `${downloadedCount}/${totalSegments}`; // 分片进度
                    onProgress(percent, `${currMB}MB`, segProgress); 
                }
            }));
        }

        // 4. 生成合并列表
        const fileListPath = path.join(tempDir, 'list.txt');
        await fs.writeFile(fileListPath, ffmpegList.join('\n'));
        
        // 5. FFmpeg 合并并修复音频流
        return new Promise((resolve, reject) => {
            const cmd = `ffmpeg -y -f concat -safe 0 -i "${fileListPath}" -c copy -bsf:a aac_adtstoasc "${outputPath}"`;
            const proc = exec(cmd, (err) => err ? reject(err) : resolve());
            // 将进程挂载到全局状态，以便能被 kill
            serverState.ffmpegCommand = proc; 
        });

    } finally {
        // 清理临时分片
        await fs.remove(tempDir).catch(() => {});
    }
}

module.exports = { downloadM3U8 };