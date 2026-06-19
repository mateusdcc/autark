import { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

import { GetTableOutput } from './interfaces';
import { DEFAULT_WORKSPACE_NAME } from '../../consts';
import { toPlain } from '../../utils';

/**
 * Reads rows from any DuckDB table as plain JavaScript objects.
 *
 * Returns the full table contents with column names as keys.
 *
 * @remarks Requires an active `AsyncDuckDBConnection`.
 */
export class GetTableUseCase {
  /** DuckDB connection used to execute queries. */
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
   * Fetches all rows from a table.
   *
   * @param tableName - unqualified name of the table to read.
   * @param workspace - workspace namespace used to qualify the table name.
   * @returns array of plain objects where each object represents one row.
   * @throws {Error} If the table does not exist or the query fails.
   * @example
   * const useCase = new GetTableUseCase(conn);
   * const rows = await useCase.exec('places');
   * console.log(rows.length);
   */
  async exec(tableName: string, workspace: string = DEFAULT_WORKSPACE_NAME): Promise<GetTableOutput> {
    const qualifiedTableName = `${workspace}.${tableName}`;
    const result = await this.conn.query(`SELECT * FROM ${qualifiedTableName}`);
    return result.toArray().map((row) => toPlain(row.toJSON())) as GetTableOutput;
  }
}
