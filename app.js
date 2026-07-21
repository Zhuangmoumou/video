const { createApp } = require('./src/createApp');
const { PORT } = require('./src/config');

const { app, taskManager } = createApp();
const server = app.listen(PORT, () => console.log(`=== 视频服务器启动于 ${PORT} ===`));

server.requestTimeout = 0;

async function shutdown(error = null) {
    if (error) console.error('[Fatal]', error);
    await taskManager.stopAndWait();
    server.close(() => process.exit(error ? 1 : 0));
}

process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
process.once('unhandledRejection', shutdown);
process.once('uncaughtException', shutdown);
