const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');

/**
 * 获取视频总时长（秒）
 */
function getDuration(url, headers) {
    return new Promise((resolve, reject) => {
        const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        ffmpeg.ffprobe(url, ['-headers', headerStr], (err, metadata) => {
            if (err) return resolve(0); // 无法获取时长则返回0
            resolve(metadata.format.duration || 0);
        });
    });
}

async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;

    // 1. 预获取时长用于计算百分比
    const totalDuration = await getDuration(m3u8Url, headers);
    
    return new Promise((resolve, reject) => {
        const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        
        const command = ffmpeg(m3u8Url)
            .inputOptions(['-headers', headerStr])
            .outputOptions(['-c', 'copy', '-bsf:a', 'aac_adtstoasc']) // 确保音频流格式正确
            .on('start', (commandLine) => {
                console.log('Spawned FFmpeg with command: ' + commandLine);
            })
            .on('progress', (progress) => {
                // progress.timemark 格式为 HH:MM:SS.mm
                if (totalDuration > 0 && progress.timemark) {
                    const parts = progress.timemark.split(':');
                    const seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
                    const percent = Math.min(99, Math.floor((seconds / totalDuration) * 100));
                    
                    // 获取已下载大小 (KB 转 MB)
                    const sizeMB = (progress.targetSize / 1024).toFixed(2);
                    if (onProgress) onProgress(percent, `${sizeMB}MB`);
                } else {
                    // 如果拿不到总时长，只显示大小
                    const sizeMB = (progress.targetSize / 1024).toFixed(2);
                    if (onProgress) onProgress(null, `${sizeMB}MB`);
                }
            })
            .on('error', (err) => {
                reject(err);
            })
            .on('end', () => {
                if (onProgress) onProgress(100, '完成');
                resolve();
            })
            .save(savePath);

        // 处理中止信号
        if (signal) {
            signal.addEventListener('abort', () => {
                command.kill('SIGKILL');
                reject(new Error('中止'));
            });
        }
    });
}

module.exports = { downloadM3u8 };