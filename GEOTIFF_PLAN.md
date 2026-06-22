# GeoTIFF improvement plan

## Main goal

Replace the current GeoTIFF loader’s expensive per-pixel-vector representation with a compact raster representation.

The work should stay mostly inside:

```txt
autk-db/src/use-cases/load-geotiff/
autk-db/src/use-cases/get-raster/
```

and only touch upstream code where the old raster payload shape is consumed.

No generic raster framework, no new raster operation suite, no legacy compatibility mode, no raster-to-points export.

---

## Confirmed technical findings

### Official DuckDB `spatial`

DuckDB’s official `spatial` extension is vector-oriented. It provides `GEOMETRY`, `ST_Read`, transforms, predicates, GDAL-backed vector IO, etc.

It does **not** provide the efficient raster API we need for GeoTIFF band arrays, raster sampling, or raster stats.

### DuckDB `raster` community extension

DuckDB has a separate `raster` community extension with `RT_Read`, `RT_ReadCells`, datacubes, etc.

But its extension metadata currently excludes WASM:

```yaml
excluded_platforms: "windows_amd64_mingw;wasm_mvp;wasm_eh;wasm_threads"
```

So it is not usable in the current `autk-db` browser/WASM setup.

### Therefore

For now, the practical path is:

- use `geotiff.js` for GeoTIFF decoding,
- avoid CSV,
- avoid per-pixel geometries,
- avoid RTREE,
- store/return compact raster arrays.

---

## What should change

### 1. Rewrite `loadGeoTiff` storage

Current loader creates one DuckDB row per pixel:

```sql
geometry GEOMETRY,
properties STRUCT(band_1 DOUBLE, ...)
```

Replace with one compact raster record.

Suggested table shape:

```sql
CREATE TABLE workspace.raster_name (
  width INTEGER,
  height INTEGER,
  min_x DOUBLE,
  min_y DOUBLE,
  max_x DOUBLE,
  max_y DOUBLE,
  origin_x DOUBLE,
  origin_y DOUBLE,
  res_x DOUBLE,
  res_y DOUBLE,
  source_crs VARCHAR,
  target_crs VARCHAR,
  bands VARCHAR[],
  band_1 FLOAT[],
  band_2 FLOAT[],
  ...
);
```

If DuckDB list columns are awkward with WASM/Arrow, store the arrays outside SQL and keep only metadata in DuckDB. But the key point remains: **no per-pixel rows**.

Remove from `loadGeoTiff`:

- CSV string generation,
- `registerFileText`,
- `read_csv`,
- `ST_Point` per pixel,
- `CREATE INDEX ... USING RTREE`,
- `maxPixels` as a hard limit based on legacy representation.

### 2. Add downsampled loading

Large rasters should not always decode at full resolution.

Use `geotiff.js` support for resampled reads:

```ts
image.readRasters({
  width: targetWidth,
  height: targetHeight,
  resampleMethod: 'bilinear',
});
```

Add/replace loader options with something like:

```ts
maxRasterCells?: number;
resampleMethod?: 'nearest' | 'bilinear';
```

Behavior:

- If `width * height <= maxRasterCells`, load full resolution.
- If larger, load a downsampled raster that fits the limit.
- Keep output metadata clear about actual loaded width/height and original width/height if needed.

This gives immediate support for much larger GeoTIFF files without tiles.

### 3. Rewrite `getRaster`

Current `getRaster` does:

```sql
list(properties ORDER BY py ASC, px ASC) AS raster
```

Replace it with direct access to the compact raster payload.

Returned raster should be flat and dense:

```ts
{
  rasterResX: width,
  rasterResY: height,
  bbox: [minX, minY, maxX, maxY],
  bands: [{ id: 'band_1', label: 'band_1' }],
  raster: Float32Array | number[]
}
```

Important: `raster` should no longer be:

```ts
[{ band_1: value }, { band_1: value }, ...]
```

It should be:

```ts
[value, value, value, ...]
```

or a typed array / transferable payload.

### 4. Update `autk-map` raster ingestion

`autk-map` currently expects raster cells as objects and resolves a `property` path per cell.

That should be simplified.

The raster layer already internally works with:

```ts
Float32Array
```

So upstream raster loading should pass a flat numeric array directly.

Change `autk-map` expectations from:

```ts
collection.features[0].properties.raster = [{ band_1: ... }, ...]
property = 'band_1'
```

to:

```ts
collection.features[0].properties.raster = Float32Array | number[]
collection.features[0].properties.bands = [...]
selectedBand = 'band_1'
```

If only one band is loaded initially, no per-cell property resolution is needed at all.

---

## What not to do

Avoid:

- keeping legacy per-pixel geometry mode,
- introducing `RasterStorage` variants,
- adding general-purpose raster operation use cases,
- adding `rasterToPoints`,
- adding tile-based storage,
- building a large raster abstraction layer,
- over-generalizing raster/vector operations now.

The first version should just make GeoTIFF loading and rendering faster/larger.

---

## Minimal implementation scope

### Files likely to change

Primary:

```txt
autk-db/src/use-cases/load-geotiff/use-case.ts
autk-db/src/use-cases/load-geotiff/interfaces.ts
autk-db/src/use-cases/get-raster/use-case.ts
autk-db/src/use-cases/get-layer/queries.ts
autk-db/src/interfaces.ts
```

Upstream consumer:

```txt
autk-map/src/layer-raster.ts
autk-map/src/api.ts
```

Possibly:

```txt
autk-map/src/layer-manager.ts
autk-map/src/layer-vector.ts
```

only if raster payload extraction currently happens there.

---

## Recommended order

1. **Change `loadGeoTiff`**
   - remove CSV and per-pixel geometries,
   - store compact raster metadata + flat band array,
   - support downsampling.

2. **Change `getRaster`**
   - return flat raster payload.

3. **Change `autk-map` raster input**
   - consume flat arrays directly.

4. **Update examples/tests**
   - adjust any gallery/usecase code that passes `property: 'band_1'` or expects pixel objects.

---

## Final plan summary

Keep GeoTIFF support simple. Use `geotiff.js` to read raster metadata and band arrays, optionally downsample large rasters, store raster data compactly instead of as per-pixel geometries, update `getRaster` and `autk-map` to pass flat numeric arrays, and remove the legacy pixel-point pipeline entirely.
