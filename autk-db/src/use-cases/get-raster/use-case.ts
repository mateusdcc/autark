import { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { FeatureCollection } from 'geojson';

import { DEFAULT_WORKSPACE_NAME } from '../../consts';
import { getRasterPayload } from '../../raster-store';

/**
 * Exports a loaded raster table as a packed FeatureCollection for rendering.
 */
export class GetRasterUseCase {
  /** DuckDB connection used to validate raster table metadata. */
  private conn: AsyncDuckDBConnection;

  /**
   * Creates a new instance bound to the given DuckDB connection.
   *
   * @param conn - Open connection used to execute SQL queries.
   */
  constructor(conn: AsyncDuckDBConnection) {
    this.conn = conn;
  }

  /**
   * Exports a raster table into a single-feature collection containing raster metadata and flat band arrays.
   *
   * @param tableName - unqualified name of the raster table to read.
   * @param workspace - workspace namespace used to qualify the table name.
   * @returns A FeatureCollection with a single feature containing raster arrays and resolution metadata.
   */
  async exec(tableName: string, workspace: string = DEFAULT_WORKSPACE_NAME): Promise<FeatureCollection<null>> {
    const qualifiedName = `${workspace}.${tableName}`;
    const metadataResult = await this.conn.query(`SELECT width, height, min_x, min_y, max_x, max_y FROM ${qualifiedName} LIMIT 1`);
    const metadata = metadataResult.toArray()[0] as Record<string, unknown> | undefined;
    if (!metadata) throw new Error(`No data found in raster table ${tableName}.`);

    const payload = getRasterPayload(workspace, tableName);
    if (!payload) {
      throw new Error(`Raster payload for table ${tableName} is not available in memory.`);
    }

    const properties: Record<string, unknown> = {
      rasterResX: payload.width,
      rasterResY: payload.height,
      bands: payload.bands,
      originalRasterResX: payload.originalWidth,
      originalRasterResY: payload.originalHeight,
    };

    for (const band of payload.bands) {
      properties[band.id] = payload.values[band.id];
    }

    return {
      type: 'FeatureCollection',
      bbox: [Number(metadata.min_x), Number(metadata.min_y), Number(metadata.max_x), Number(metadata.max_y)],
      features: [
        {
          type: 'Feature',
          geometry: null,
          properties,
        },
      ],
    };
  }
}
