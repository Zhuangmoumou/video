const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');

/**
 * 辅助：将相对路径转换为绝对URL
 */
function resolveUrl(baseUrl, relativeUrl) {
    if (relativeUrl.startsWith('http')) return relativeUrl;
    return new URL(relativeUrl, baseUrl).href;
}

/**
 * 辅助：下载单个文件 (TS片)
 */
async function downloadFile(url, dest, headers, retries = 3) {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers,
            timeout: 30000
        });
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (err) {
        if (retries > 0) return downloadFile(url, dest, headers, retries - 1);
        throw err;
    }
}

/**
 * 核心：解析 M3U8 并处理嵌套
 */
async function parseM3u8(url, headers) {
    const res = await axios.get(url, { headers, timeout: 10000 });
    const content = res.data;
    const lines = content.split('\n');
    
    // 检查是否为嵌套列表 (Master Playlist)
    if (content.includes('#EXT-X-STREAM-INF')) {
        let bestBandwidth = 0;
        let bestUrl = null;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('BANDWIDTH=')) {
                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
                if (bandwidth > bestBandwidth) {
                    bestBandwidth = bandwidth;
                    bestUrl = lines[i+1].trim();
                }
            }
        }
        if (bestUrl) {
            const nextUrl = resolveUrl(url, bestUrl);
            return parseM3u8(nextUrl, headers); // 递归解析
        }
    }

    // 解析 TS 列表
    const tsList = [];
    let totalDuration = 0;
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const dur = parseFloat(line.split(':')[1]);
            if (!isNaN(dur)) totalDuration += dur;
            
            // 下一行通常是 URL，但也可能是其他 tag
            let nextLine = lines[i+1] ? lines[i+1].trim() : '';
            while (nextLine.startsWith('#') && i < lines.length - 1) {
                 i++;
                 nextLine = lines[i+1] ? lines[i+1].trim() : '';
            }
            if (nextLine && !nextLine.startsWith('#')) {
                tsList.push(resolveUrl(url, nextLine));
                i++; 
            }
        }
    }
    return { tsList, totalDuration };
}

/**
 * M3U8 下载主函数 (手动解析 + 下载 + 合并)
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;
    const tempDir = path.join(path.dirname(savePath), `temp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    let lastPercent = -1;
    // 更新进度的限流函数
    const notifyProgress = (completed, total) => {
        if (!onProgress) return;
        const percent = Math.floor((completed / total) * 100);
        
        // 只有百分比变化时才回调，精度 1%
        if (percent !== lastPercent) {
            lastPercent = percent;
            // 估算大小 (简单累加文件大小太慢，这里仅计算MB)
            // 这里我们传递百分比和简单的状态字符串
            // 在手动下载模式下，我们很难实时获取精确的总大小，除非 head 请求每个 TS
            // 所以这里先只传进度
            onProgress(percent, `已下载分片: ${completed}/${total}`, 'calculating...');
        }
    };

    try {
        // 1. 解析
        if (onProgress) onProgress(0, '正在解析播放列表...', '0 MB');
        const { tsList } = await parseM3u8(m3u8Url, headers);
        if (tsList.length === 0) throw new Error('未找到视频分片');

        // 2. 并发下载
        const total = tsList.length;
        let completed = 0;
        let downloadedBytes = 0; // 累计已下载字节
        const concurrency = 10;
        const localFiles = [];

        for (let i = 0; i < total; i += concurrency) {
            if (signal && signal.aborted) throw new Error('中止');

            const chunk = tsList.slice(i, i + concurrency);
            await Promise.all(chunk.map(async (tsUrl, idx) => {
                const globalIdx = i + idx;
                const fileName = `${String(globalIdx).padStart(5, '0')}.ts`;
                const filePath = path.join(tempDir, fileName);
                localFiles[globalIdx] = filePath;

                await downloadFile(tsUrl, filePath, headers);
                
                // 统计大小
                try {
                    const stat = await fs.stat(filePath);
                    downloadedBytes += stat.size;
                } catch(e) {}

                completed++;
                
                // 计算大小字符串
                const sizeMB = (downloadedBytes / 1024 / 1024).toFixed(2) + ' MB';
                
                // 这里的 percent 实际上代表“下载阶段”的进度，
                // 为了给后面的合并留出空间，我们把下载阶段映射到 0-90%
                const phasePercent = Math.floor((completed / total) * 90);
                if (phasePercent !== lastPercent) {
                    lastPercent = phasePercent;
                    onProgress(phasePercent, `分片下载中 ${completed}/${total}`, sizeMB);
                }
            }));
        }

        // 3. 生成列表并合并
        const fileListPath = path.join(tempDir, 'files.txt');
        const fileContent = localFiles.map(f => `file '${f}'`).join('\n');
        await fs.writeFile(fileListPath, fileContent);

        if (onProgress) onProgress(92, '正在合并并修复音频...', '处理中');

        await new Promise((resolve, reject) => {
            const cmd = ffmpeg()
                .input(fileListPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                    '-c', 'copy',            // 视频流复制
                    '-bsf:a', 'aac_adtstoasc', // 修复音频
                    '-y'
                ])
                .save(savePath);

            cmd.on('end', resolve);
            cmd.on('error', reject);
            if (signal) {
                signal.addEventListener('abort', () => {
                    cmd.kill('SIGKILL');
                    reject(new Error('中止'));
                });
            }
        });

        if (onProgress) onProgress(100, '完成', 'OK');

    } catch (err) {
        throw err;
    } finally {
        // 清理临时目录
        try { await fs.remove(tempDir); } catch (e) {}
    }
}

module.exports = { downloadM3u8 };