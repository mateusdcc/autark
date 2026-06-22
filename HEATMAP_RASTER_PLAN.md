# Plan: make `buildHeatmap` use the same raster format/path as GeoTIFF

## Goal

Change `autk-db` heatmaps to use the same compact raster representation now used by GeoTIFF:

- one raster metadata record in DuckDB
- flat band arrays in memory
- `db.getRaster()` returns the packed raster collection
- `autk-map` consumes it through the same raster path

So heatmaps stop using the old geometry-per-cell + properties-per-cell raster representation.

---

## Current situation

### GeoTIFF now uses
- compact raster metadata
- in-memory flat arrays
- `getRaster()` as the export path

### Heatmap still uses
- one point geometry per grid cell
- `properties.band_1`, `properties.band_2`, etc. per row
- old raster-style table in DuckDB
- export through `getLayer()` / raster SQL packing logic

So today there are two raster models in `autk-db`.

---

## Desired end state

Both GeoTIFF rasters and heatmap rasters should look the same to downstream code:

```ts
{
  type: 'FeatureCollection',
  bbox: [...],
  features: [
    {
      type: 'Feature',
      geometry: null,
      properties: {
        rasterResX,
        rasterResY,
        bands,
        band_1: [...],
        band_2: [...],
      }
    }
  ]
}
```

And both should be backed by:

- table metadata in DuckDB
- array payloads in the raster store

---

## High-level approach

### 1. Reuse the raster-store pattern
Use the same in-memory raster payload store already introduced for GeoTIFF.

Heatmaps should write:

- raster width / height
- bbox
- band metadata
- flat arrays per band

into that store.

No new raster abstraction is needed beyond reusing that existing path.

### 2. Rewrite `BuildHeatmapUseCase`
Instead of creating a geometry table with one point per cell and then transforming it into a raster-like table, `buildHeatmap` should:

1. compute the grid dimensions and bbox
2. run the aggregation
3. build one flat array per output band
4. create a compact one-row DuckDB metadata table
5. store the arrays in `raster-store`

So the output becomes a true compact raster, not a vector table pretending to be raster.

### 3. Keep the aggregation logic as much as possible
Do not over-refactor.

The useful part of current `buildHeatmap` is the aggregation logic. The part to replace is mainly the output representation.

So:

- keep as much of the query/aggregation behavior as possible
- replace the final storage/export format

---

## Concrete implementation direction

### Step 1 — inspect the current heatmap result path
Current files involved:

- `autk-db/src/use-cases/build-heatmap/use-case.ts`
- `autk-db/src/use-cases/spatial-join/use-case.ts`
- `autk-db/src/use-cases/get-layer/queries.ts`

Current pattern:
- create a grid table with one `ST_Point` per cell
- spatial join onto it
- write `properties.band_n`
- mark it as `type: 'raster'`

This is the part to replace.

### Step 2 — generate flat arrays instead of per-cell rows
After aggregation, produce arrays in row-major order:

- `band_1[cellIndex]`
- `band_2[cellIndex]`
- etc.

with:

```ts
cellIndex = row * columns + column
```

Missing values become `0` so heatmap semantics stay stable.

### Step 3 — create compact metadata table
Like GeoTIFF, create a single-row table with fields such as:

- `width`
- `height`
- `original_width`
- `original_height`
- `min_x`
- `min_y`
- `max_x`
- `max_y`
- `origin_x`
- `origin_y`
- `res_x`
- `res_y`
- `source_crs`
- `target_crs`

For heatmap:
- `source_crs` and `target_crs` can both be the workspace CRS
- `origin_x`, `origin_y`, `res_x`, `res_y` come from the heatmap grid definition

### Step 4 — store arrays in `raster-store`
Use the same storage path as GeoTIFF.

Then `getRaster(tableName)` can work for:
- GeoTIFF
- heatmap

through the same compact raster payload logic.

### Step 5 — route heatmap raster export through `getRaster()`
Right now heatmaps are effectively exported through `getLayer()` because they still look like renderable geometry tables.

After the change:

- heatmap tables should be fetched through `getRaster()`
- or `getLayer()` should special-case compact raster tables the same way it now special-cases GeoTIFF

Prefer a minimal schema-based distinction between compact raster tables and geometry-backed layer tables instead of introducing a new public storage-mode API.

---

## Files likely to change

### Main
- `autk-db/src/use-cases/build-heatmap/use-case.ts`
- `autk-db/src/use-cases/get-raster/use-case.ts`
- `autk-db/src/db.ts`

### Likely
- `autk-db/src/interfaces.ts`
- `autk-db/src/raster-store.ts`

### Maybe
- `autk-db/src/use-cases/get-layer/queries.ts`
- `autk-db/src/use-cases/get-layer/use-case.ts`

---

## What not to do

- do not create a second raster export pipeline just for heatmaps
- do not keep geometry-per-cell heatmaps around for compatibility
- do not introduce tiles
- do not create a broad raster framework
- do not refactor spatial join more than needed

---

## Recommended execution order

1. Refactor `buildHeatmap` output only
   - keep existing aggregation as much as possible
   - replace final storage with compact raster arrays
2. Store heatmap arrays in `raster-store`
   - same path as GeoTIFF
3. Teach `db.getRaster()` / `db.getLayer()` to use the compact raster path for heatmaps
   - not only for GeoTIFF
4. Update gallery/usecases that load heatmaps
   - make sure they fetch compact rasters through the right path
5. Verify map rendering
   - heatmap examples should still render, now through the same raster contract as GeoTIFF

---

## Final summary

Keep the current heatmap aggregation logic mostly intact, but replace its output format so it produces the same compact raster representation as GeoTIFF: one metadata row in DuckDB, flat band arrays in the raster store, and export through the same `getRaster()` path used by GeoTIFF.
