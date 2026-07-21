const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { API_DEFAULT_RESOLUTION, RESOLUTION_PRESETS } = require('./config');
const { createProgressLimiter } = require('./utils/progress');
const { parseTimeToSeconds } = require('./modLoader');

const getVideoCrf = (profile) => (profile?.id === 'source' ? '15' : '17');

const formatCutSecond = (value) => Number(value.toFixed(3)).toString();

const clampPercent = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, Math.floor(numeric)));
};

const getRangeDuration = (range) => {
    if (!Number.isFinite(range?.start) || !Number.isFinite(range?.end)) return null;
    return Math.max(0, range.end - range.start);
};

const formatCutRange = (range) => {
    const toClock = (seconds) => {
        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const body = h > 0
            ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const ms = seconds - total;
        return ms > 0 ? `${body}.${String(Math.round(ms * 1000)).padStart(3, '0')}` : body;
    };
    return `${toClock(range.start)}-${toClock(range.end)}`;
};

const buildCompressOutputOptions = (profile) => {
    const options = [];
    if (profile?.scaleFilter) {
        options.push('-vf', profile.scaleFilter);
    }
    options.push(
        '-c:v', 'libx264',
        '-crf', getVideoCrf(profile),
        '-preset', 'medium',
        '-c:a', 'copy'
    );
    return options;
};

const probeDuration = (inputPath) => new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
        if (error) {
            console.error(`[FFprobe] 获取时长失败: ${error.message || error}`);
            resolve(null);
            return;
        }
        const duration = Number(metadata?.format?.duration);
        resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
    });
});

const buildKeepRanges = (cutRanges, duration = null) => {
    const ranges = [];
    const total = Number.isFinite(duration) && duration > 0 ? duration : null;
    let cursor = 0;

    for (const range of cutRanges) {
        const cutStart = total == null ? range.start : Math.min(range.start, total);
        const cutEnd = total == null ? range.end : Math.min(range.end, total);
        if (cutStart > cursor + 0.001) {
            ranges.push({ start: cursor, end: cutStart });
        }
        cursor = Math.max(cursor, cutEnd);
    }

    if (total == null || cursor < total - 0.001) {
        ranges.push({ start: cursor, end: total });
    }

    return ranges;
};

const buildTrimFilter = (range, audio = false, profile = RESOLUTION_PRESETS[API_DEFAULT_RESOLUTION]) => {
    const filter = audio ? 'atrim' : 'trim';
    const reset = audio
        ? 'asetpts=PTS-STARTPTS'
        : profile?.scaleFilter
            ? `setpts=PTS-STARTPTS,${profile.scaleFilter}`
            : 'setpts=PTS-STARTPTS';
    const start = formatCutSecond(range.start);
    const end = Number.isFinite(range.end) ? `:end=${formatCutSecond(range.end)}` : '';
    return `${filter}=start=${start}${end},${reset}`;
};

const runFfmpegSave = (cmd, outputPath, serverState, onProgress) => new Promise((resolve, reject) => {
    serverState.ffmpegCommand = cmd;
    cmd.on('progress', (progress) => {
        if (onProgress) onProgress(progress);
    });
    cmd.on('start', (commandLine) => console.log(`[FFmpeg] ${commandLine}`));
    cmd.on('end', () => {
        if (serverState.ffmpegCommand === cmd) serverState.ffmpegCommand = null;
        resolve();
    });
    cmd.on('error', (error) => {
        if (serverState.ffmpegCommand === cmd) serverState.ffmpegCommand = null;
        reject(error);
    });
    cmd.save(outputPath);
});

const concatSegments = async (segmentPaths, tempDir, outPath, serverState) => {
    const listPath = path.join(tempDir, 'list.txt');
    const listContent = segmentPaths
        .map((segmentPath) => `file '${path.basename(segmentPath)}'`)
        .join('\n');
    await fs.writeFile(listPath, listContent);

    await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', 'list.txt',
            '-c', 'copy',
            outPath
        ], { cwd: tempDir });
        let stderr = '';

        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('error', reject);
        proc.on('close', (code, signal) => {
            if (serverState.ffmpegCommand === proc) serverState.ffmpegCommand = null;
            if (code === 0) {
                resolve();
                return;
            }
            const reason = signal ? `signal=${signal}` : `code=${code}`;
            reject(new Error(`ffmpeg 拼接裁剪片段失败 (${reason})\n${stderr}`));
        });

        serverState.ffmpegCommand = proc;
    });
};

const compressVideo = async (
    downloadPath,
    outPath,
    cutRanges,
    compressionProfile = RESOLUTION_PRESETS[API_DEFAULT_RESOLUTION],
    serverState,
    updateStatus
) => {
    if (!cutRanges.length) {
        if (compressionProfile?.passthrough) {
            updateStatus(null, '📦 原画直出...');
            await fs.copy(downloadPath, outPath, { overwrite: true });
            return;
        }

        const shouldReportCompressProgress = createProgressLimiter();
        const cmd = ffmpeg(downloadPath)
            .outputOptions(buildCompressOutputOptions(compressionProfile));

        await runFfmpegSave(cmd, outPath, serverState, (p) => {
            const percent = Math.floor(p.percent || 0);
            if (!shouldReportCompressProgress({ percent })) return;
            const outMB = (p.targetSize / 1024).toFixed(2);
            updateStatus(null, `📦 压缩: ${percent}% (${outMB}MB)`);
        });
        return;
    }

    const duration = await probeDuration(downloadPath);
    const keepRanges = buildKeepRanges(cutRanges, duration);
    if (!keepRanges.length) throw new Error('裁剪区间覆盖了整个视频，无法生成输出');
    const keepDurations = keepRanges.map(getRangeDuration);
    const totalKeepDuration = keepDurations.every((value) => Number.isFinite(value) && value > 0)
        ? keepDurations.reduce((sum, value) => sum + value, 0)
        : null;

    const tempDir = path.join(path.dirname(outPath), `cut_tmp_${Date.now()}`);
    await fs.ensureDir(tempDir);

    try {
        const segmentPaths = [];
        const shouldReportCutProgress = createProgressLimiter();
        let completedKeepDuration = 0;
        for (let i = 0; i < keepRanges.length; i++) {
            const range = keepRanges[i];
            const segmentDuration = keepDurations[i];
            const segmentPath = path.join(tempDir, `segment_${String(i).padStart(3, '0')}.mp4`);
            const cmd = ffmpeg(downloadPath)
                .outputOptions([
                    '-vf', buildTrimFilter(range, false, compressionProfile),
                    '-af', buildTrimFilter(range, true, compressionProfile),
                    '-c:v', 'libx264',
                    '-crf', getVideoCrf(compressionProfile),
                    '-preset', 'medium',
                    '-c:a', 'aac',
                    '-b:a', '192k'
                ]);

            updateStatus(null, `📦 压缩片段 ${i + 1}/${keepRanges.length}...`);
            await runFfmpegSave(cmd, segmentPath, serverState, (p) => {
                const timemarkSeconds = parseTimeToSeconds(p.timemark);
                const processedSeconds = Number.isFinite(timemarkSeconds) && Number.isFinite(segmentDuration) && segmentDuration > 0
                    ? Math.min(timemarkSeconds, segmentDuration)
                    : null;
                const segmentPercent = processedSeconds !== null
                    ? clampPercent((processedSeconds / segmentDuration) * 100)
                    : clampPercent(p.percent || 0);
                const overallPercent = totalKeepDuration && processedSeconds !== null
                    ? clampPercent(((completedKeepDuration + processedSeconds) / totalKeepDuration) * 100)
                    : clampPercent(((i + (segmentPercent / 100)) / keepRanges.length) * 100);
                if (!shouldReportCutProgress({ percent: overallPercent })) return;
                const outMB = (p.targetSize / 1024).toFixed(2);
                updateStatus(null, `📦 裁剪压缩: ${overallPercent}% [片段 ${i + 1}/${keepRanges.length}: ${segmentPercent}%] (${outMB}MB)`);
            });
            segmentPaths.push(segmentPath);
            completedKeepDuration += Number.isFinite(segmentDuration) ? segmentDuration : 0;
            const completedPercent = totalKeepDuration
                ? clampPercent((completedKeepDuration / totalKeepDuration) * 100)
                : clampPercent(((i + 1) / keepRanges.length) * 100);
            updateStatus(null, `📦 裁剪压缩: ${completedPercent}% [片段 ${i + 1}/${keepRanges.length}: 100%]`);
        }

        updateStatus(null, '📦 拼接裁剪片段...');
        await concatSegments(segmentPaths, tempDir, outPath, serverState);
    } finally {
        await fs.remove(tempDir).catch(() => {});
    }
};

module.exports = { compressVideo, formatCutRange, buildCompressOutputOptions };
