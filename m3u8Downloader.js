const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { URL } = require('url');

/**
 * 解析 M3U8 内容，获取 TS 文件列表
 */
async function parseM3u8(m3u8Url, headers) {
    const response = await axios.get(m3u8Url, { headers });
    const content = response.data;
    const lines = content.split('\n');
    const tsList = [];
    
    // 处理相对路径
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    for (let line of lines) {
        line = line.trim();
        if (line && !line.startsWith('#')) {
            if (line.startsWith('http')) {
                tsList.push(line);
            } else if (line.startsWith('/')) {
                const u = new URL(m3u8Url);
                tsList.push(`${u.protocol}//${u.host}${line}`);
            } else {
                tsList.push(baseUrl + line);
            }
        }
    }
    return tsList;
}

/**
 * 下载单个 TS 片段
 */
async function downloadTs(url, destPath, headers, retries = 3) {
    try {
        const writer = fs.createWriteStream(destPath);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers,
            timeout: 10000
        });
        
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (err) {
        if (retries > 0) {
            // console.log(`Retry ${url} ...`);
            return downloadTs(url, destPath, headers, retries - 1);
        }
        throw err;
    }
}

async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;
    
    // 创建临时目录
    const tempDir = path.join(path.dirname(savePath), `temp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    try {
        if (onProgress) onProgress(0, '正在解析 M3U8...');
        
        // 1. 解析 M3U8
        const tsUrls = await parseM3u8(m3u8Url, headers);
        const totalSegments = tsUrls.length;
        
        if (totalSegments === 0) throw new Error('未找到 TS 分片');

        // 2. 并发下载 TS 分片
        const concurrency = 10; // 并发数
        let completed = 0;
        const tsFiles = [];

        // 分批处理
        for (let i = 0; i < totalSegments; i += concurrency) {
            if (signal && signal.aborted) throw new Error('中止');

            const chunk = tsUrls.slice(i, i + concurrency);
            const promises = chunk.map(async (url, idx) => {
                const globalIdx = i + idx;
                const fileName = `${String(globalIdx).padStart(5, '0')}.ts`;
                const filePath = path.join(tempDir, fileName);
                
                await downloadTs(url, filePath, headers);
                tsFiles[globalIdx] = filePath; // 保持顺序
                
                completed++;
                const percent = Math.floor((completed / totalSegments) * 80); // 下载占 80% 进度
                if (onProgress) onProgress(percent, `下载分片: ${completed}/${totalSegments}`);
            });

            await Promise.all(promises);
        }

        // 3. 生成 filelist.txt
        const fileListPath = path.join(tempDir, 'filelist.txt');
        const fileContent = tsFiles.map(f => `file '${f}'`).join('\n');
        await fs.writeFile(fileListPath, fileContent);

        // 4. FFmpeg 合并并修复音频
        if (onProgress) onProgress(85, '正在合并并修复音频...');
        
        await new Promise((resolve, reject) => {
            const cmd = ffmpeg()
                .input(fileListPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                    '-c:v', 'copy', // 视频流直接复制，速度快
                    '-c:a', 'aac',  // 音频重新编码
                    '-ac', '2',     // 强制双声道
                    // 核心修复：pan滤镜。c0=c0|c1=c0 表示：左声道=原左，右声道=原左。
                    // 这能解决绝大多数“双声道重叠/相位抵消”的听感问题。
                    '-af', 'pan=stereo|c0=c0|c1=c0' 
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

        if (onProgress) onProgress(100, 'M3U8 处理完成');

    } catch (err) {
        throw err;
    } finally {
        // 清理临时文件
        try {
            await fs.remove(tempDir);
        } catch (e) {
            console.error('清理临时文件失败:', e.message);
        }
    }
}

module.exports = { downloadM3u8 };