function createAbortError(message = '任务被中止') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function isAbortError(error) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.name === 'CanceledError') return true;
    if (error.code === 'ERR_CANCELED' || error.code === 'ABORT_ERR') return true;
    return /任务被中止|aborted|canceled|cancelled/i.test(String(error.message || ''));
}

function throwIfAborted(signal, message = '任务被中止') {
    if (signal?.aborted) throw createAbortError(message);
}

function raceWithAbort(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(createAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

function sleep(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError());
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

module.exports = {
    createAbortError,
    isAbortError,
    throwIfAborted,
    raceWithAbort,
    sleep,
};
