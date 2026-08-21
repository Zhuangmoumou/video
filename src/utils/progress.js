const PROGRESS_MAX_UPDATES_PER_SECOND = 5;
const PROGRESS_UPDATE_INTERVAL_MS = 1000 / PROGRESS_MAX_UPDATES_PER_SECOND;
const SPEED_AVERAGE_WINDOW_MS = 3000;
const SPEED_MIN_SAMPLE_MS = 1000;
const SPEED_UPDATE_INTERVAL_MS = 1000;
const SPEED_SMOOTHING_FACTOR = 0.35;
/** 距最后样本超过此时长视为停滞（下载卡住），getSpeed 开始衰减 */
const SPEED_STALE_MS = 1500;
/** 停滞时速度指数衰减的半衰期：每 1.2s 速度减半，几秒内归零 */
const SPEED_DECAY_HALF_LIFE_MS = 1200;

function normalizePercent(percent) {
    if (percent === undefined || percent === null) return null;
    const numeric = Number(percent);
    return Number.isFinite(numeric) ? numeric : null;
}

function createProgressLimiter() {
    let lastUpdateTime = 0;
    let lastPercent = null;

    return ({ force = false, percent = null } = {}) => {
        const now = Date.now();
        const normalizedPercent = normalizePercent(percent);
        const percentChanged = normalizedPercent !== null && normalizedPercent !== lastPercent;

        if (!force && !percentChanged && now - lastUpdateTime < PROGRESS_UPDATE_INTERVAL_MS) {
            return false;
        }

        if (normalizedPercent !== null) {
            lastPercent = normalizedPercent;
        }
        lastUpdateTime = now;
        return true;
    };
}

function createSpeedAverager({
    windowMs = SPEED_AVERAGE_WINDOW_MS,
    minSampleMs = SPEED_MIN_SAMPLE_MS,
    updateIntervalMs = SPEED_UPDATE_INTERVAL_MS,
    smoothingFactor = SPEED_SMOOTHING_FACTOR,
    staleMs = SPEED_STALE_MS,
    decayHalfLifeMs = SPEED_DECAY_HALF_LIFE_MS
} = {}) {
    let samples = [];
    let lastSpeed = 0;
    let lastBytes = null;
    let lastSpeedUpdateTime = null;
    let lastSampleTime = null;

    const sample = (totalBytes, now = Date.now()) => {
        const bytes = Number(totalBytes);
        if (!Number.isFinite(bytes) || bytes < 0) return lastSpeed;

        // 停滞（下载卡住）后恢复：丢弃旧窗口，避免把停滞时长算进速度造成低估
        if (lastSampleTime !== null && now - lastSampleTime > staleMs) {
            samples = [];
            lastSpeed = 0;
            lastSpeedUpdateTime = null;
        }

        if (lastBytes !== null && bytes < lastBytes) {
            samples = [];
            lastSpeed = 0;
            lastSpeedUpdateTime = null;
        }

        lastBytes = bytes;
        lastSampleTime = now;
        samples.push({ time: now, bytes });

        const cutoff = now - windowMs;
        while (samples.length > 2 && samples[1].time <= cutoff) {
            samples.shift();
        }

        const oldest = samples[0];
        const elapsed = now - oldest.time;
        const downloadedBytes = bytes - oldest.bytes;
        const canUpdateSpeed = lastSpeedUpdateTime === null || now - lastSpeedUpdateTime >= updateIntervalMs;

        if (elapsed >= minSampleMs && downloadedBytes >= 0 && canUpdateSpeed) {
            const rawSpeed = downloadedBytes * 1000 / elapsed;
            lastSpeed = lastSpeed > 0
                ? lastSpeed + (rawSpeed - lastSpeed) * smoothingFactor
                : rawSpeed;
            lastSpeedUpdateTime = now;
        }

        return lastSpeed;
    };

    // 停滞时速度随时间指数衰减到 0，而不是一直停在旧值
    const getSpeed = (now = Date.now()) => {
        if (lastSampleTime === null) return 0;
        const idleMs = now - lastSampleTime;
        if (idleMs <= staleMs) return lastSpeed;
        return lastSpeed * Math.pow(0.5, (idleMs - staleMs) / decayHalfLifeMs);
    };

    return {
        sample,
        getSpeed
    };
}

module.exports = {
    PROGRESS_MAX_UPDATES_PER_SECOND,
    PROGRESS_UPDATE_INTERVAL_MS,
    SPEED_AVERAGE_WINDOW_MS,
    SPEED_MIN_SAMPLE_MS,
    SPEED_UPDATE_INTERVAL_MS,
    SPEED_SMOOTHING_FACTOR,
    SPEED_STALE_MS,
    SPEED_DECAY_HALF_LIFE_MS,
    createProgressLimiter,
    createSpeedAverager
};
