import { ColorMapDomainStrategy, ColorMapInterpolator } from '@urban-toolkit/autk-core';
import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkMap } from '@urban-toolkit/autk-map';

const URL = (import.meta as any).env.BASE_URL;
const ELEVATION_LAYER_ID = 'niteroi_elevation';

export class TerrainLayersNiteroi {
    protected map!: AutkMap;
    protected db!: AutkDb;

    public async run(canvas: HTMLCanvasElement): Promise<void> {
        this.db = new AutkDb();
        await this.db.init();

        await this.db.loadOsm({
            queryArea: {
                geocodeArea: 'Rio de Janeiro',
                areas: ['Niterói'],
            },
            outputTableName: 'table_osm',
            autoLoadLayers: {
                layers: [
                    'surface',
                    'parks',
                    'water',
                    'roads'
                ] as Array<'surface' | 'parks' | 'water' | 'roads' | 'buildings'>,
            },
        });

        await this.db.loadGeoTiff({
            geotiffFileUrl: `${URL}data/niteroi-elevation.tif`,
            coordinateFormat: 'EPSG:3395',
            outputTableName: ELEVATION_LAYER_ID,
        });

        console.log(`Loaded GeoTIFF table: ${ELEVATION_LAYER_ID}`);

        // await this.db.loadGeojson({
        //     geojsonFileUrl: `${URL}data/nit_buildings.geojson`,
        //     outputTableName: 'lotes',
        //     layerType: 'buildings',
        // });

        this.map = new AutkMap(canvas);

        await this.map.init();
        await this.loadLayers();
        this.map.updateRenderInfo(ELEVATION_LAYER_ID, { isColorMap: true, opacity: 0.55 });
        const elevation = await this.db.getRaster(ELEVATION_LAYER_ID);
        this.map.enableTerrainMode(elevation, 'band_1');
        this.map.draw();
    }

    protected async loadLayers(): Promise<void> {
        for (const layerData of this.db.getLayersMetadata()) {
            const geojson = await this.db.getLayer(layerData.name);
            this.map.loadCollection(layerData.name, {
                collection: geojson,
                type: layerData.type,
                loadConfig: { buildingsZeroHeight: true },
            });
            console.log(`Loading layer: ${layerData.name} of type ${layerData.type}`);
        }
        const elevation = await this.db.getRaster(ELEVATION_LAYER_ID);
        this.map.loadCollection(ELEVATION_LAYER_ID, {
            collection: elevation,
            type: 'raster',
            property: 'band_1',
        });
        this.map.updateColorMap(ELEVATION_LAYER_ID, {
            colorMap: {
                interpolator: ColorMapInterpolator.SEQ_TURBO,
                domainSpec: { type: ColorMapDomainStrategy.PERCENTILE, params: [2, 98] },
            },
        });
    }

}

async function main() {
    const canvas = document.querySelector('canvas');
    if (!canvas) {
        throw new Error('No canvas found');
    }
    
    const example = new TerrainLayersNiteroi();
    await example.run(canvas);
}
main();
