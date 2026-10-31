// Renders the hourly graph with sample data to SVG files, without a browser.
// Handy for checking chart changes:  npm run render-chart
import { writeFileSync, mkdirSync } from 'node:fs';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { buildOption, type ChartView } from '../src/chart.ts';
import { buildModel } from '../src/forecast.ts';
import { sampleForecast } from '../tests/sample.ts';

echarts.use([SVGRenderer]);

const outDir = process.argv[2] ?? 'chart-preview';
mkdirSync(outDir, { recursive: true });

const base = { nowIdx: 17, unit: 'mph' as const, windyMph: 20, gustLimit: 30 };
const views: Record<string, [number, ChartView]> = {
  '48h': [7, { ...base, a: 12, b: 60, hourStep: 3, arrowStep: 2, longDayLabels: true }],
  '7days': [7, { ...base, a: 0, b: 168, hourStep: 6, arrowStep: 6, longDayLabels: false }],
  '16days': [16, { ...base, a: 0, b: 384, hourStep: 12, arrowStep: 12, longDayLabels: false }],
};

for (const [name, [days, view]] of Object.entries(views)) {
  const model = buildModel(sampleForecast(days));
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 646, height: 240 });
  chart.setOption(buildOption(model, view));
  const svg = chart
    .renderToSVGString()
    .replace(/(<svg[^>]*>)/, '$1<rect width="100%" height="100%" fill="#111A22"/>');
  chart.dispose();
  writeFileSync(`${outDir}/${name}.svg`, svg);
  console.log(`wrote ${outDir}/${name}.svg`);
}
