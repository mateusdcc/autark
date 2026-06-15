import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkMap, MapEvent } from '@urban-toolkit/autk-map';
import type { Feature, FeatureCollection } from 'geojson';

const LAYER = 'table_osm_buildings';

export class BuildingPickingVis {
    protected map!: AutkMap;
    protected db!: AutkDb;
    protected buildings!: FeatureCollection;

    public async run(canvas: HTMLCanvasElement): Promise<void> {
        this.db = new AutkDb();
        await this.db.init();

        await this.db.loadOsm({
            queryArea: {
                geocodeArea: 'New York',
                areas: ['Battery Park City', 'Financial District'],
            },
            outputTableName: 'table_osm',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads', 'buildings'] as Array<
                    'surface' | 'parks' | 'water' | 'roads' | 'buildings'
                >,
            },
        });

        this.buildings = await this.db.getLayer(LAYER);

        this.map = new AutkMap(canvas);
        await this.map.init();
        await this.loadLayers();

        this.map.updateRenderInfo(LAYER, { isPick: true });
        this.map.events.on(MapEvent.PICKING, ({ selection, layerId }) => {
            if (layerId !== LAYER) return;

            if (selection.length === 0) {
                this.map.setHighlightedIds(LAYER, []);
                this.resetPanel();
                return;
            }

            const pickedId = selection[selection.length - 1];
            this.map.setHighlightedIds(LAYER, [pickedId]);
            this.showBuildingInfo(pickedId);
        });

        this.map.draw();
        this.resetPanel();
    }

    protected async loadLayers(): Promise<void> {
        for (const layerData of this.db.getLayersMetadata()) {
            const geojson = layerData.name === LAYER
                ? this.buildings
                : await this.db.getLayer(layerData.name);
            this.map.loadCollection(layerData.name, { collection: geojson, type: layerData.type });
        }
    }

    protected showBuildingInfo(pickedId: number): void {
        const feature = this.buildings.features[pickedId] as Feature;
        if (!feature) return;

        const props = (feature.properties ?? {}) as Record<string, unknown>;
        const get = (...keys: string[]): string => {
            for (const k of keys) {
                const v = props[k];
                if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
            }
            return '—';
        };

        const levels = get('building:levels', 'levels');
        const heightRaw = get('height');
        const height = heightRaw !== '—'
            ? heightRaw
            : levels !== '—' ? `~${(Number(levels) * 3).toFixed(0)} m (est.)` : '—';

        this.updatePanel({
            title: get('name', 'addr:housename') !== '—'
                ? get('name', 'addr:housename')
                : `Building ${pickedId}`,
            osmId: get('id', 'osm_id', '@id'),
            type: get('building'),
            height,
            levels,
            address: [get('addr:housenumber'), get('addr:street')]
                .filter(v => v !== '—').join(' ') || '—',
        });
    }

    protected resetPanel(): void {
        this.updatePanel({ title: 'Click a building', osmId: '—', type: '—', height: '—', levels: '—', address: '—' });
    }

    protected updatePanel(values: {
        title: string;
        osmId: string;
        type: string;
        height: string;
        levels: string;
        address: string;
    }): void {
        const set = (id: string, text: string) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };
        set('info-title', values.title);
        set('info-osm-id', values.osmId);
        set('info-type', values.type);
        set('info-height', values.height);
        set('info-levels', values.levels);
        set('info-address', values.address);
    }
}

async function main() {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('No canvas found');
    const example = new BuildingPickingVis();
    await example.run(canvas);
}
main();
