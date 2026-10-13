const { isAbortError, throwIfAborted, sleep } = require('./abort');

const MAX_DOWNLOAD_ATTEMPTS = 3;

async function retryDownload(operation, {
    signal,
    maxAttempts = MAX_DOWNLOAD_ATTEMPTS,
    delayMs = 1000,
    onRetry
} = {}) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(signal);
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            if (signal?.aborted || isAbortError(error) || attempt === maxAttempts) {
                throw error;
            }

            if (onRetry) onRetry(error, attempt, maxAttempts);
            await sleep(delayMs, signal);
        }
    }

    throw lastError;
}

module.exports = { MAX_DOWNLOAD_ATTEMPTS, retryDownload };
