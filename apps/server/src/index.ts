import { buildApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024～65535');
const { app } = await buildApp({ development: process.env.TAVERN_DEV === '1', port, logger: true, dataDirectory: process.env.TAVERN_DATA_DIR });
try {
  await app.listen({ host: '127.0.0.1', port });
  process.stdout.write(`\n  共叙 · Tavern Studio\n  http://127.0.0.1:${port}\n  本地运行 · 不自动启动或下载模型\n\n`);
} catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
