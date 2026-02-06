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
 * 极简版 M3U8 下载
 * 对应命令: ffmpeg -i [URL] -c copy -bsf:a aac_adtstoasc [FILE]
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress } = options;
    
    // 1. 获取时长用于进度计算
    let totalDuration = 0;
    if (onProgress) {
        onProgress(0, '正在连接...');
        totalDuration = await getM3u8Duration(m3u8Url);
    }

    return new Promise((resolve, reject) => {
        // 确保目录存在
        fs.ensureDirSync(path.dirname(savePath));

        // 构建 FFmpeg 命令
        const command = ffmpeg(m3u8Url)
            .outputOptions([
                '-y',                       // 强制覆盖输出文件 (必须，否则文件存在时会报错)
                '-c', 'copy',               // 视频音频直接流复制
                '-bsf:a', 'aac_adtstoasc',   // 修复 M3U8->MP4 音频流
                '-movflags', 'faststart'
            ]);

        let lastPercent = -1;

        // 监听进度
        command.on('progress', (progress) => {
            if (!onProgress) return;

            // 获取文件大小
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

            // 只有进度变化时才更新
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
                reject(err);
            }
        });

        // 支持任务中止
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