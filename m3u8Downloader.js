const ffmpeg = require('fluent-ffmpeg');

/**
 * 使用 FFmpeg 下载 M3U8，确保音频平滑且进度精确
 */
async function downloadM3u8(m3u8Url, savePath, options = {}) {
    const { signal, onProgress, headers = {} } = options;

    // 将 headers 对象转换为 FFmpeg 要求的字符串格式
    const headerString = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n') + '\r\n';

    return new Promise((resolve, reject) => {
        let lastPercent = -1; // 记录上一次发送的进度

        const command = ffmpeg(m3u8Url)
            .inputOptions([
                '-headers', headerString,
                '-protocol_whitelist', 'file,http,https,tcp,tls'
            ])
            .outputOptions([
                '-c', 'copy',              // 下载阶段仅拷贝，不重编码
                '-bsf:a', 'aac_adtstoasc' // 修复音频封装
            ])
            .on('progress', (progress) => {
                // 仅当 FFmpeg 能够计算出百分比时执行
                if (progress.percent !== undefined && progress.percent !== null) {
                    // 取整，确保精度为 1%
                    let currentPercent = Math.floor(progress.percent);

                    // 限制范围在 0-100 之间（FFmpeg 有时会输出微小的负数或略超 100）
                    if (currentPercent < 0) currentPercent = 0;
                    if (currentPercent > 100) currentPercent = 100;

                    // 核心逻辑：只有当前进度大于上一次记录的进度时，才触发更新
                    if (currentPercent > lastPercent) {
                        lastPercent = currentPercent;
                        if (onProgress) {
                            onProgress(currentPercent);
                        }
                    }
                }
            })
            .on('end', () => {
                // 确保结束时进度达到 100%
                if (lastPercent < 100 && onProgress) onProgress(100);
                resolve();
            })
            .on('error', (err) => {
                // 忽略由手动杀掉进程引起的错误
                if (err.message.includes('SIGKILL') || err.message.includes('ffmpeg was killed')) {
                    return;
                }
                reject(err);
            })
            .save(savePath);

        // 处理外部中止信号
        if (signal) {
            signal.addEventListener('abort', () => {
                try {
                    command.kill('SIGKILL');
                } catch (e) {}
                reject(new Error('中止'));
            });
        }
    });
}

module.exports = { downloadM3u8 };
