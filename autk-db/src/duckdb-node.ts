import * as duckdb from '@duckdb/duckdb-wasm';

const NODE_PATH_MODULE = 'node:path';
const NODE_WORKER_THREADS_MODULE = 'node:worker_threads';
const NODE_MODULE_MODULE = 'node:module';

/**
 * Loads and instantiates a Node.js DuckDB-Wasm database.
 *
 * @returns An initialized `AsyncDuckDB` instance ready to open connections.
 * @throws If the worker fails to start or database instantiation fails.
 */
export async function loadDb() {
  const path = await import(/* @vite-ignore */ NODE_PATH_MODULE);
  const { Worker: NodeWorker } = await import(/* @vite-ignore */ NODE_WORKER_THREADS_MODULE);
  const { createRequire } = await import(/* @vite-ignore */ NODE_MODULE_MODULE);
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm'));
  const workerPath = path.join(dist, 'duckdb-node-eh.worker.cjs');

  const stub =
    `const { parentPort } = require('node:worker_threads');` +
    `globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);` +
    `parentPort.on('message', (data) => { if (typeof globalThis.onmessage === 'function') globalThis.onmessage({ data }); });` +
    `require(${JSON.stringify(workerPath)});`;
  const nodeWorker = new NodeWorker(stub, { eval: true });

  const listeners = new Map<(event: any) => void, [string, (...args: any[]) => void]>();
  const adapter = {
    addEventListener(event: string, handler: (e: any) => void) {
      const wrapped =
        event === 'error'
          ? (err: any) =>
              handler({
                error: err,
                message: err?.message ?? String(err),
                target: adapter,
              })
          : (data: any) => handler({ data, target: adapter });
      listeners.set(handler, [event, wrapped]);
      nodeWorker.on(event, wrapped);
    },
    removeEventListener(_event: string, handler: (e: any) => void) {
      const registered = listeners.get(handler);
      if (registered) {
        nodeWorker.off(registered[0], registered[1]);
        listeners.delete(handler);
      }
    },
    postMessage(data: any, transfer?: any[]) {
      nodeWorker.postMessage(data, transfer);
    },
    terminate() {
      return nodeWorker.terminate();
    },
  };

  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), adapter as unknown as Worker);
  await db.instantiate(path.join(dist, 'duckdb-eh.wasm'));
  return db;
}
