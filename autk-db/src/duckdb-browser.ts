import * as duckdb from '@duckdb/duckdb-wasm';

/**
 * Resolves the browser DuckDB-Wasm bundles for the current module location.
 *
 * Local app builds can load worker/wasm assets emitted next to this bundle.
 * CDN-transformed module hosts such as esm.sh often do not expose those sidecar
 * assets reliably, so they use the official DuckDB jsDelivr bundles instead.
 */
function resolveBrowserBundles(): duckdb.DuckDBBundles {
  try {
    const base = import.meta.url;
    if (base.startsWith('file:')) {
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

    if (base.startsWith('http:') || base.startsWith('https:')) {
      const url = new URL(base);
      const usesLocalAssets =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname.endsWith('.local');

      if (usesLocalAssets) {
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
