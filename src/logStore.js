function formatArg(arg) {
    if (typeof arg !== 'object' || arg === null) return String(arg);
    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
}

function createLogStore(limit = 85) {
    const entries = [];
    const add = (type, args) => {
        const message = args.map(formatArg).join(' ');
        const isProgress = message.includes('[进程]');
        const cleanMessage = message.replace('[进程] ', '');
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const time = `${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const line = `[${time}] [${type}] ${isProgress ? '⏳进度: ' : ''}${cleanMessage}`;
        if (isProgress && entries.at(-1)?.includes('⏳进度:')) entries[entries.length - 1] = line;
        else entries.push(line);
        while (entries.length > limit) entries.shift();
    };
    return {
        add,
        clearProgress: () => {
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].includes('⏳进度:')) entries.splice(i, 1);
            }
        },
        clear: () => entries.splice(0, entries.length),
        list: () => entries.slice(),
        recent: (count) => entries.slice(-count)
    };
}

function installConsoleCapture(logStore) {
    const originalLog = console.log.bind(console);
    const originalError = console.error.bind(console);
    console.log = (...args) => { logStore.add('INFO', args); originalLog(...args); };
    console.error = (...args) => { logStore.add('ERROR', args); originalError(...args); };
    return () => { console.log = originalLog; console.error = originalError; };
}

module.exports = { createLogStore, installConsoleCapture };
