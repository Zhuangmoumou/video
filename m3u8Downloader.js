const axios = require('axios');
const fs = require('fs-extra');

/**
 * 路径解析工具
 */
function resolveUrl(baseUrl, relativeUrl) {
    return new URL(relativeUrl, baseUrl).href;
}

/**
 * 手动解析并下载 M3U8
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;

    try {
        // 1. 获取 M3U8 内容
        const response = await axios.get(m3u8Url, { headers, signal, timeout: 10000 });
        const content = response.data;
        const currentBaseUrl = m3u8Url;

        // 2. 处理嵌套 M3U8 (Master Playlist)
        if (content.includes('#EXT-X-STREAM-INF')) {
            const lines = content.split('\n');
            const subM3u8 = lines.find(l => l.trim() && !l.startsWith('#'));
            if (subM3u8) {
                const nextUrl = resolveUrl(currentBaseUrl, subM3u8.trim());
                return downloadM3u8(nextUrl, savePath, options);
            }
        }

        // 3. 解析所有 TS 片段链接
        const tsUrls = content.split('\n')
            .filter(l => l.trim() && !l.startsWith('#'))
            .map(l => resolveUrl(currentBaseUrl, l.trim()));

        const total = tsUrls.length;
        if (total === 0) throw new Error('未找到有效的视频片段');

        // 4. 顺序下载并写入文件
        const outputStream = fs.createWriteStream(savePath);
        let finished = 0;
        let lastPercent = -1;

        for (let i = 0; i < tsUrls.length; i++) {
            // 检查是否被用户中止
            if (signal?.aborted) {
                outputStream.destroy();
                throw new Error('中止');
            }

            const tsUrl = tsUrls[i];
            const res = await axios.get(tsUrl, {
                headers,
                responseType: 'arraybuffer',
                signal,
                timeout: 30000
            });

            outputStream.write(Buffer.from(res.data));
            finished++;

            // --- 进度节流逻辑 ---
            const currentPercent = Math.floor((finished / total) * 100);
            if (currentPercent !== lastPercent) {
                lastPercent = currentPercent;
                if (onProgress) onProgress(currentPercent);
            }
        }

        return new Promise((resolve, reject) => {
            outputStream.end();
            outputStream.on('finish', resolve);
            outputStream.on('error', reject);
        });

    } catch (error) {
        throw error;
    }
}

module.exports = { downloadM3u8 };