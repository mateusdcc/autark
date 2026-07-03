import * as duckdb from '@duckdb/duckdb-wasm';

/**
 * Resolves the browser DuckDB-Wasm bundles for the current module location.
 *
 * When the module is served over HTTP(S) or from disk, the worker and wasm
 * assets emitted next to the bundle are used. When the module was loaded from
 * a blob:/data: URL (e.g. bundled into an anywidget ESM), relative asset URLs
 * cannot be resolved, so the official jsDelivr CDN bundles are used instead.
 */
function resolveBrowserBundles(): duckdb.DuckDBBundles {
  try {
    const base = import.meta.url;
    if (base.startsWith('http:') || base.startsWith('https:') || base.startsWith('file:')) {
      return {
        mvp: {
          mainModule: new URL(/* @vite-ignore */ './duckdb-mvp.wasm', base).href,
          mainWorker: new URL(/* @vite-ignore */ './duckdb-browser-mvp.worker.js', base).href,
        },
        eh: {
          mainModule: new URL(/* @vite-ignore */ './duckdb-eh.wasm', base).href,
          mainWorker: new URL(/* @vite-ignore */ './duckdb-browser-eh.worker.js', base).href,
        },
      };
    }
  } catch {
    // Fall through to CDN bundles.
  }
  return duckdb.getJsDelivrBundles();
}

/**
 * Loads and instantiates a browser DuckDB-Wasm database.
 *
 * @returns An initialized `AsyncDuckDB` instance ready to open connections.
 * @throws If DuckDB assets cannot be resolved, the worker fails to start, or database instantiation fails.
 */
export async function loadDb() {
  const bundle = await duckdb.selectBundle(resolveBrowserBundles());
  const workerBlobUrl = URL.createObjectURL(
    new Blob([`importScripts(${JSON.stringify(bundle.mainWorker!)});`], {
      type: 'text/javascript',
    }),
  );
  try {
    const worker = new Worker(workerBlobUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule);
    return db;
  } finally {
    URL.revokeObjectURL(workerBlobUrl);
  }
}
