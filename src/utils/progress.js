const PROGRESS_MAX_UPDATES_PER_SECOND = 5;
const PROGRESS_UPDATE_INTERVAL_MS = 1000 / PROGRESS_MAX_UPDATES_PER_SECOND;
const SPEED_AVERAGE_WINDOW_MS = 3000;
const SPEED_MIN_SAMPLE_MS = 1000;
const SPEED_UPDATE_INTERVAL_MS = 1000;
const SPEED_SMOOTHING_FACTOR = 0.35;

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
    smoothingFactor = SPEED_SMOOTHING_FACTOR
} = {}) {
    let samples = [];
    let lastSpeed = 0;
    let lastBytes = null;
    let lastSpeedUpdateTime = null;

    const sample = (totalBytes, now = Date.now()) => {
        const bytes = Number(totalBytes);
        if (!Number.isFinite(bytes) || bytes < 0) return lastSpeed;

        if (lastBytes !== null && bytes < lastBytes) {
            samples = [];
            lastSpeed = 0;
            lastSpeedUpdateTime = null;
        }

        lastBytes = bytes;
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

    return {
        sample,
        getSpeed: () => lastSpeed
    };
}

module.exports = {
    PROGRESS_MAX_UPDATES_PER_SECOND,
    PROGRESS_UPDATE_INTERVAL_MS,
    SPEED_AVERAGE_WINDOW_MS,
    SPEED_MIN_SAMPLE_MS,
    SPEED_UPDATE_INTERVAL_MS,
    SPEED_SMOOTHING_FACTOR,
    createProgressLimiter,
    createSpeedAverager
};
