const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

/**
 * 辅助函数：解析 M3U8 获取总时长 (秒)
 */
async function getM3u8Duration(url) {
    try {
        const response = await axios.get(url, { timeout: 10000 });
        const content = response.data;
        let totalDuration = 0;
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('#EXTINF:')) {
                const durationStr = line.split(':')[1].split(',')[0];
                const duration = parseFloat(durationStr);
                if (!isNaN(duration)) totalDuration += duration;
            }
        }
        return totalDuration;
    } catch (e) {
        return 0;
    }
}

/**
 * 辅助函数：将 timemark 转换为秒
 */
function parseTimemark(timemark) {
    if (typeof timemark === 'number') return timemark;
    if (!timemark) return 0;
    const parts = timemark.split(':');
    let seconds = 0;
    if (parts.length === 3) {
        seconds += parseFloat(parts[0]) * 3600;
        seconds += parseFloat(parts[1]) * 60;
        seconds += parseFloat(parts[2]);
    }
    return seconds;
}

/**
 * 使用 FFmpeg 直接下载 M3U8
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress } = options;
    
    // 1. 尝试获取总时长
    let totalDuration = 0;
    if (onProgress) {
        onProgress(0, '正在分析流媒体信息...');
        totalDuration = await getM3u8Duration(m3u8Url);
    }

    // 2. 准备目录和清理旧文件
    try {
        const dir = path.dirname(savePath);
        await fs.ensureDir(dir);
        if (await fs.pathExists(savePath)) {
            await fs.remove(savePath); // 显式删除，避免占用
        }
    } catch (e) {
        throw new Error(`文件系统错误: ${e.message}`);
    }

    return new Promise((resolve, reject) => {
        const command = ffmpeg(m3u8Url)
            .inputOptions([
                // 关键修复：允许所有常用协议，防止因 crypto/https 被拦截导致报错
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '10',
                '-rw_timeout', '15000000', // 15秒超时
                '-allowed_extensions', 'ALL'
            ])
            .outputOptions([
                '-y',                   // 覆盖输出
                '-c', 'copy',           // 直接复制流
                '-bsf:a', 'aac_adtstoasc', // 修复音频流
                '-movflags', 'faststart'
            ]);

        let lastPercent = -1;

        // 调试：输出生成的命令，方便排查
        command.on('start', (cmdLine) => {
            console.log('[FFmpeg Command]', cmdLine);
        });

        command.on('progress', (progress) => {
            if (!onProgress) return;
            
            let currentSizeMB = '0.00';
            if (progress.targetSize) {
                currentSizeMB = (progress.targetSize / 1024).toFixed(2);
            }
            
            let percent = 0;
            if (totalDuration > 0) {
                const currentSeconds = parseTimemark(progress.timemark);
                percent = Math.floor((currentSeconds / totalDuration) * 100);
                if (percent > 99) percent = 99; 
            }

            if (percent !== lastPercent) {
                lastPercent = percent;
                const sizeInfo = `(已下载: ${currentSizeMB} MB)`;
                if (totalDuration > 0) {
                    onProgress(percent, `📥 M3U8下载中: ${percent}% ${sizeInfo}`);
                } else {
                    onProgress(percent, `📥 M3U8下载中... ${sizeInfo}`);
                }
            }
        });

        command.on('end', () => {
            if (onProgress) onProgress(100, '✅ M3U8下载完成');
            resolve();
        });

        command.on('error', (err) => {
            // 过滤掉中止信号导致的错误
            if (err.message.includes('SIGKILL') || (signal && signal.aborted)) {
                reject(new Error('中止'));
            } else {
                // 提取简短错误信息
                let msg = err.message;
                // 尝试提取 ffmpeg 的具体 stderr 输出
                if (msg.includes('ffmpeg exited with code')) {
                   // 很多时候 fluent-ffmpeg 的 error 对象没有包含详细的 stderr
                   // 这里保留原始消息以便调试
                   msg = `FFmpeg Error: ${msg}`;
                }
                reject(new Error(msg));
            }
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                command.kill('SIGKILL');
                reject(new Error('中止'));
            });
        }

        command.save(savePath);
    });
}

module.exports = { downloadM3u8 };