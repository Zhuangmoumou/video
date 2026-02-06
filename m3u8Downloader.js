const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');

/**
 * 辅助函数：解析 M3U8 获取总时长 (秒)
 * 用于计算下载进度百分比
 */
async function getM3u8Duration(url, headers) {
    try {
        const response = await axios.get(url, { headers, timeout: 10000 });
        const content = response.data;
        const lines = content.split('\n');
        let totalDuration = 0;
        
        // 简单累加 #EXTINF: 后的时长
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
        // 如果无法获取时长，返回 0，进度条将显示 "下载中..." 而不是百分比
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
 * 使用 FFmpeg 直接下载 M3U8
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;
    let totalDuration = 0;
    let lastPercent = -1;

    // 1. 尝试获取总时长以便显示进度
    if (onProgress) {
        onProgress(0, '正在分析流媒体信息...');
        totalDuration = await getM3u8Duration(m3u8Url, headers);
    }

    // 2. 构造 Headers 字符串 (FFmpeg 格式: "Key: Value\r\nKey: Value")
    let headersStr = '';
    for (const [key, val] of Object.entries(headers)) {
        headersStr += `${key}: ${val}\r\n`;
    }

    return new Promise((resolve, reject) => {
        // 确保输出目录存在
        fs.ensureDirSync(require('path').dirname(savePath));

        const command = ffmpeg(m3u8Url)
            .inputOptions([
                '-headers', headersStr,
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-allowed_extensions', 'ALL'
            ])
            .outputOptions([
                '-c', 'copy',           // 视频和音频直接复制，不转码，速度最快
                '-bsf:a', 'aac_adtstoasc', // 修复 m3u8 转 mp4 常见的音频流格式错误
                '-movflags', 'faststart'
            ]);

        // 监听进度
        command.on('progress', (progress) => {
            if (!onProgress) return;

            // 获取当前文件大小 (KB -> MB)
            const currentSizeMB = (progress.targetSize / 1024).toFixed(2);
            let percent = 0;
            let percentStr = '';

            // 计算百分比
            if (totalDuration > 0) {
                const currentSeconds = parseTimemark(progress.timemark);
                percent = Math.floor((currentSeconds / totalDuration) * 100);
                // 限制在 99%，直到 end 事件触发
                if (percent > 99) percent = 99; 
            }

            // 仅当百分比变化时回调 (精度控制)
            if (percent !== lastPercent) {
                lastPercent = percent;
                const sizeInfo = `(已下载: ${currentSizeMB} MB)`;
                
                if (totalDuration > 0) {
                    onProgress(percent, `📥 M3U8下载中: ${percent}% ${sizeInfo}`);
                } else {
                    // 如果无法获取总时长，只显示已下载大小
                    onProgress(-1, `📥 M3U8下载中... ${sizeInfo}`);
                }
            }
        });

        command.on('end', () => {
            if (onProgress) onProgress(100, '✅ M3U8下载完成');
            resolve();
        });

        command.on('error', (err) => {
            // 如果是因为中止导致的错误，不视为报错
            if (err.message.includes('SIGKILL') || (signal && signal.aborted)) {
                reject(new Error('中止'));
            } else {
                reject(new Error(`FFmpeg下载出错: ${err.message}`));
            }
        });

        // 处理中止信号
        if (signal) {
            signal.addEventListener('abort', () => {
                command.kill('SIGKILL');
                reject(new Error('中止'));
            });
        }

        // 开始保存
        command.save(savePath);
    });
}

module.exports = { downloadM3u8 };