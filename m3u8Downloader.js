const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

/**
 * 辅助函数：解析 M3U8 获取总时长 (秒)
 * 用于计算下载进度百分比
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
                if (!isNaN(duration)) {
                    totalDuration += duration;
                }
            }
        }
        return totalDuration;
    } catch (e) {
        return 0;
    }
}

/**
 * 辅助函数：将 timemark (00:01:23.45) 转换为秒
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
 * 使用 FFmpeg 直接下载 M3U8 (无 Header 版 + 强制覆盖)
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress } = options;
    
    // 1. 尝试获取总时长
    let totalDuration = 0;
    if (onProgress) {
        onProgress(0, '正在分析流媒体信息...');
        totalDuration = await getM3u8Duration(m3u8Url);
    }

    return new Promise((resolve, reject) => {
        // 确保输出目录存在
        try {
            fs.ensureDirSync(path.dirname(savePath));
        } catch (e) {
            return reject(new Error(`无法创建目录: ${e.message}`));
        }

        const command = ffmpeg(m3u8Url)
            .inputOptions([
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '10',
                '-rw_timeout', '15000000',
                '-allowed_extensions', 'ALL'
            ])
            .outputOptions([
                '-y',                   // <--- 关键修复：强制覆盖已存在的文件
                '-c', 'copy',           // 视频音频直接流复制
                '-bsf:a', 'aac_adtstoasc', 
                '-movflags', 'faststart'
            ]);

        let lastPercent = -1;

        // 监听进度
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
            if (err.message.includes('SIGKILL') || (signal && signal.aborted)) {
                reject(new Error('中止'));
            } else {
                const simpleErr = err.message.split('\n')[0];
                reject(new Error(`FFmpeg下载出错: ${simpleErr}`));
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