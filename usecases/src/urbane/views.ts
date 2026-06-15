import { FeatureCollection } from 'geojson';

import { AutkPlot, PlotEvent } from '@urban-toolkit/autk-plot';
import { AutkMap, MapEvent } from '@urban-toolkit/autk-map';
import { ColorMapDomainStrategy } from '@urban-toolkit/autk-core';

import { ROAD_SKY_VIEW_FIELD, SCORE_FIELD, SKY_EXPOSURE_FIELD } from './analysis';

type UrbaneLevel = 'neighborhoods' | 'active_buildings';
type LayerTable = { name: string, type: string };

export class UrbaneViews {
    public map!: AutkMap;
    public table!: AutkPlot;
    public parallel!: AutkPlot;

    public constructor(
        protected plotDivParallel: HTMLElement,
        protected plotDivTable: HTMLElement,
    ) {}

    public async initMap(canvas: HTMLCanvasElement): Promise<void> {
        this.map = new AutkMap(canvas);
        await this.map.init();
    }

    public async initAllLayers(
        layerTables: LayerTable[],
        getLayer: (name: string) => Promise<FeatureCollection>,
        neighborhoods: FeatureCollection,
        roadsWithSky?: FeatureCollection,
    ): Promise<void> {
        for (const layerData of layerTables) {
            const collection = layerData.name === 'neighborhoods'
                ? neighborhoods
                : await getLayer(layerData.name);

            if (layerData.type === 'points') { continue; }
            this.map.loadCollection(layerData.name, { collection, type: layerData.type as any });
        }

        this.map.updateRenderInfo('table_osm_buildings', { isPick: false });
        this.map.updateRenderInfo('neighborhoods', { opacity: 0.75, isPick: true, isSkip: true });


        if (roadsWithSky) {
            this.map.updateColorMap('table_osm_roads', { colorMap: {
                domainSpec: { type: ColorMapDomainStrategy.PERCENTILE, params: [5, 95] },
            }, });
            this.map.updateThematic('table_osm_roads', {
                collection: roadsWithSky,
                property: `properties.${ROAD_SKY_VIEW_FIELD}`,
            });
            this.map.updateRenderInfo('table_osm_roads', { isColorMap: true });
        }

        this.map.draw();
    }

    public updateThematic(
        level: UrbaneLevel,
        geojson: FeatureCollection,
        column: string,
    ): void {
        if (column === 'none') {
            this.map.updateRenderInfo(level, { isColorMap: false });
            this.map.draw();
            return;
        }

        this.map.updateColorMap(level, { colorMap: {
            domainSpec: column === SKY_EXPOSURE_FIELD || column === ROAD_SKY_VIEW_FIELD
                ? { type: ColorMapDomainStrategy.PERCENTILE, params: [5, 95] }
                : { type: ColorMapDomainStrategy.MIN_MAX },
        }, });

        this.map.updateThematic(level, { collection: geojson, property: `properties.${column}` });
        this.map.updateRenderInfo(level, { isColorMap: true });
        this.map.draw();
    }

    public reloadPlots(
        level: UrbaneLevel,
        datasets: string[],
        neighborhoods: FeatureCollection,
        activeBuildings?: FeatureCollection,
    ): void {
        this.plotDivParallel.innerHTML = '';
        this.plotDivTable.innerHTML = '';

        const attributes = [
            ...datasets.map((dataset) => `sjoin.count.${dataset}`),
            SKY_EXPOSURE_FIELD,
            SCORE_FIELD,
        ];
        const axisLabels = [...datasets, 'sky exposure', 'score'];
        const plotData = level === 'neighborhoods' ? neighborhoods : activeBuildings!;
        const titleCol = level === 'neighborhoods' ? 'ntaname' : 'addr:street';
        const title = `${level} characteristics`;

        this.parallel = new AutkPlot(this.plotDivParallel, {
            type: 'parallel-coordinates',
            collection: plotData,
            attributes: { axis: attributes },
            labels: { axis: axisLabels, title },
            width: 790,
            events: [PlotEvent.BRUSH_Y],
        });

        this.table = new AutkPlot(this.plotDivTable, {
            type: 'table',
            collection: plotData,
            attributes: { axis: [titleCol, ...attributes] },
            labels: { axis: ['Id', ...axisLabels], title },
            width: 790,
            events: [PlotEvent.CLICK],
        });
    }

    public bindMapSelection(
        getCurrentLevel: () => UrbaneLevel,
        onSelection: (selection: number[]) => void,
    ): void {
        this.map.events.on(MapEvent.PICKING, ({ selection, layerId }: { selection: number[]; layerId: string }) => {
            if (layerId !== getCurrentLevel()) return;
            this.table?.setSelection(selection);
            this.parallel?.setSelection(selection);
            onSelection(selection);
        });
    }

    public bindPlotSelection(
        getCurrentLevel: () => UrbaneLevel,
        onSelection: (selection: number[]) => void,
    ): void {
        this.table.events.on(PlotEvent.CLICK, ({ selection }) => {
            this.map.setHighlightedIds(getCurrentLevel(), selection);
            this.parallel.setSelection(selection);
            onSelection(selection);
        });

        this.parallel.events.on(PlotEvent.BRUSH_Y, ({ selection }) => {
            this.map.setHighlightedIds(getCurrentLevel(), selection);
            this.table.setSelection(selection);
            onSelection(selection);
        });
    }

    public showBuildingsLevel(activeBuildings: FeatureCollection): void {
        this.map.loadCollection('active_buildings', { collection: activeBuildings, type: 'buildings' });
        this.map.updateRenderInfo('table_osm_buildings', { isSkip: true });
        this.map.updateRenderInfo('neighborhoods', { isSkip: true, isPick: false });
        this.map.updateRenderInfo('active_buildings', { isSkip: false, isPick: true });
        this.map.draw();
    }

    public showNeighborhoodLevel(): void {
        this.map.removeLayer('active_buildings');
        this.map.updateRenderInfo('table_osm_buildings', { isSkip: false, isPick: false });
        this.map.updateRenderInfo('neighborhoods', { isSkip: false, isPick: true });
        this.map.draw();
    }
}
