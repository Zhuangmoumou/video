const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

/**
 * 自动处理相对/绝对路径
 */
function resolveUrl(baseUrl, relativeUrl) {
    return new URL(relativeUrl, baseUrl).href;
}

/**
 * 手动解析并下载 M3U8
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;
    const tempDir = `${savePath}_parts`;
    await fs.ensureDir(tempDir);

    try {
        // 1. 获取 M3U8 内容
        let response = await axios.get(m3u8Url, { headers, signal });
        let content = response.data;
        let currentBaseUrl = m3u8Url;

        // 2. 处理嵌套 M3U8 (Master Playlist)
        if (content.includes('#EXT-X-STREAM-INF')) {
            const lines = content.split('\n');
            const subM3u8 = lines.find(l => l.trim() && !l.startsWith('#'));
            const nextUrl = resolveUrl(currentBaseUrl, subM3u8.trim());
            console.log(`[M3U8] 发现嵌套链接，跳转至: ${nextUrl}`);
            return downloadM3u8(nextUrl, savePath, options);
        }

        // 3. 解析 TS 链接
        const lines = content.split('\n');
        const tsUrls = lines
            .filter(l => l.trim() && !l.startsWith('#'))
            .map(l => resolveUrl(currentBaseUrl, l.trim()));

        const total = tsUrls.length;
        if (total === 0) throw new Error('未找到任何 TS 片段');

        console.log(`[M3U8] 解析完成，共 ${total} 个片段`);

        // 4. 并发下载 TS 片段 (限制并发数为 5，防止被封)
        const poolLimit = 5;
        let finished = 0;
        const outputStream = fs.createWriteStream(savePath);

        // 为了保证顺序合并，我们先下载到临时文件，再按顺序写入
        // 或者直接按顺序下载。为了简单且保证顺序，这里采用分批次顺序下载
        for (let i = 0; i < tsUrls.length; i++) {
            if (signal?.aborted) throw new Error('任务被用户中止');

            const tsUrl = tsUrls[i];
            const retry = 3;
            let success = false;

            for (let r = 0; r < retry; r++) {
                try {
                    const res = await axios.get(tsUrl, { 
                        headers, 
                        responseType: 'arraybuffer', 
                        signal,
                        timeout: 30000 
                    });
                    outputStream.write(Buffer.from(res.data));
                    success = true;
                    break;
                } catch (e) {
                    if (r === retry - 1) throw e;
                    console.log(`[M3U8] 片段 ${i} 下载失败，重试 ${r + 1}...`);
                }
            }

            finished++;
            if (onProgress) {
                onProgress(Math.floor((finished / total) * 100));
            }
        }

        outputStream.end();
        await fs.remove(tempDir);
        return true;

    } catch (error) {
        await fs.remove(tempDir);
        throw error;
    }
}

module.exports = { downloadM3u8 };