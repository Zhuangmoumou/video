const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

/**
 * 辅助函数：解析 M3U8 获取总时长 (秒)
 * 用于计算下载进度百分比
 */
async function getM3u8Duration(url, headers) {
    try {
        const response = await axios.get(url, { 
            headers, 
            timeout: 10000 
        });
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
 * 使用 FFmpeg 直接下载 M3U8 (带防盗链 Headers)
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;
    
    // 1. 获取时长 (带 Headers 请求)
    let totalDuration = 0;
    if (onProgress) {
        onProgress(0, '正在连接并分析流信息...');
        totalDuration = await getM3u8Duration(m3u8Url, headers);
    }

    // 2. 构造 inputOptions
    // 分离 User-Agent 和其他 Headers
    let userAgent = 'Mozilla/5.0';
    let headerLines = [];

    for (const [key, val] of Object.entries(headers)) {
        if (key.toLowerCase() === 'user-agent') {
            userAgent = val;
        } else {
            headerLines.push(`${key}: ${val}`);
        }
    }

    // 基础参数
    const inputOptions = [
        '-user_agent', userAgent,                   // 单独设置 UA
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data', // 关键：允许所有协议
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '10',
        '-rw_timeout', '30000000',                  // 15秒网络超时
        '-allowed_extensions', 'ALL'
    ];

    // 添加 Headers (如果有)
    // 格式：Key: Value\r\nKey: Value
    if (headerLines.length > 0) {
        const headersStr = headerLines.join('\r\n') + '\r\n';
        inputOptions.push('-headers', headersStr);
    }

    return new Promise((resolve, reject) => {
        // 确保目录存在
        fs.ensureDirSync(path.dirname(savePath));

        const command = ffmpeg(m3u8Url)
            .inputOptions(inputOptions)
            .outputOptions([
                '-y',                       // 强制覆盖
                '-c', 'copy',               // 直接流复制
                '-bsf:a', 'aac_adtstoasc',  // 修复音频
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