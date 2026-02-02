const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');

function resolveUrl(baseUrl, relativeUrl) {
    return new URL(relativeUrl, baseUrl).href;
}

async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;
    
    // 建立临时目录存放 TS 片段
    const tempDir = path.join(path.dirname(savePath), `temp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    try {
        // 1. 获取 M3U8
        const response = await axios.get(m3u8Url, { headers, signal, timeout: 10000 });
        let content = response.data;
        const currentBaseUrl = m3u8Url;

        // 2. 处理嵌套 M3U8
        if (content.includes('#EXT-X-STREAM-INF')) {
            const lines = content.split('\n');
            const subM3u8 = lines.find(l => l.trim() && !l.startsWith('#'));
            if (subM3u8) {
                return downloadM3u8(resolveUrl(currentBaseUrl, subM3u8.trim()), savePath, options);
            }
        }

        // 3. 解析 TS 链接
        const tsUrls = content.split('\n')
            .filter(l => l.trim() && !l.startsWith('#'))
            .map(l => resolveUrl(currentBaseUrl, l.trim()));

        const total = tsUrls.length;
        if (total === 0) throw new Error('未找到有效的视频片段');

        // 4. 手动逐个下载 TS 文件
        let finished = 0;
        let lastPercent = -1;
        const fileListPath = path.join(tempDir, 'filelist.txt');
        const fileEntries = [];

        for (let i = 0; i < tsUrls.length; i++) {
            if (signal?.aborted) throw new Error('中止');

            const tsFileName = `seg_${i}.ts`;
            const tsPath = path.join(tempDir, tsFileName);
            
            const res = await axios.get(tsUrls[i], {
                headers,
                responseType: 'arraybuffer',
                signal,
                timeout: 30000
            });

            await fs.writeFile(tsPath, Buffer.from(res.data));
            
            // 记录到 FFmpeg 的 concat 列表（注意转义单引号）
            fileEntries.push(`file '${tsPath.replace(/'/g, "'\\''")}'`);
            
            finished++;

            // 进度控制：1% 精度且仅在增加时更新
            const currentPercent = Math.floor((finished / total) * 100);
            if (currentPercent > lastPercent) {
                lastPercent = currentPercent;
                if (onProgress) onProgress(currentPercent);
            }
        }

        // 5. 写入 FFmpeg 列表文件
        await fs.writeFile(fileListPath, fileEntries.join('\n'));

        // 6. 使用 FFmpeg 进行无损合并 (解决音频噪音的关键)
        // -f concat: 使用合并分离器
        // -safe 0: 允许读取任意路径
        // -c copy: 直接拷贝流，不重新编码，速度极快
        await new Promise((resolve, reject) => {
            const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${fileListPath}" -c copy "${savePath}"`;
            const proc = exec(ffmpegCmd, (err) => {
                if (err) reject(err);
                else resolve();
            });

            if (signal) {
                signal.addEventListener('abort', () => {
                    proc.kill('SIGKILL');
                    reject(new Error('中止'));
                });
            }
        });

    } finally {
        // 7. 清理临时文件
        try {
            await fs.remove(tempDir);
        } catch (e) {}
    }
}

module.exports = { downloadM3u8 };
