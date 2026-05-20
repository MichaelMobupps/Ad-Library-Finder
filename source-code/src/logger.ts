const ts = () => new Date().toISOString();

export const log = {
  info: (msg: string, meta?: unknown) => console.log(`[${ts()}] [INFO] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: unknown) => console.warn(`[${ts()}] [WARN] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: unknown) => console.error(`[${ts()}] [ERR ] ${msg}`, meta ?? ''),
  debug: (msg: string, meta?: unknown) => console.log(`[${ts()}] [DBG ] ${msg}`, meta ?? ''),
};
