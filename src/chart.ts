// The hourly graph: sustained wind (solid), gusts (dashed, shaded band),
// direction arrows, an hour axis and a day axis. Every tick mark has a value.
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { hourShort, levelFor, niceScale, toMph, UNIT_LABEL, type Model, type Unit } from './forecast.ts';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
]);

export interface ChartView {
  /** First and last hour index on the x axis. */
  a: number;
  b: number;
  /** Hours between labelled ticks on the hour axis. */
  hourStep: number;
  /** Hours between direction arrows. */
  arrowStep: number;
  /** Day labels as "Sat Oct 31" (short range) or "Sat" (long range). */
  longDayLabels: boolean;
  nowIdx: number;
  unit: Unit;
  windyMph: number;
  /** Gust limit in display units. */
  gustLimit: number;
}

const C = {
  text: '#E6EDF3',
  label: '#B7C4D0',
  muted: '#8A9AAA',
  axis: '#5A6B7A',
  grid: '#1F2B36',
  midnight: '#2E3D4B',
  blue: '#4EA8DE',
  orange: '#F2A541',
  limit: '#E8673C',
  limitText: '#F08A63',
  cursor: '#CFE4F5',
};

const FONT = "'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif";
// Points "up" (north) at 0°; rotated so each arrow shows where the wind blows TO.
const ARROW = 'path://M0,-8 L5,-1 L1.7,-2 L1.7,8 L-1.7,8 L-1.7,-2 L-5,-1 Z';

type Point = [number, number | '-'];

export function buildOption(model: Model, v: ChartView): EChartsCoreOption {
  const hrs = model.hours;
  const inView = hrs.filter((h) => h.i >= v.a && h.i <= v.b);

  let top = v.gustLimit;
  for (const h of inView) top = Math.max(top, h.g ?? 0, h.s ?? 0);
  const [yMax, yStep] = niceScale(top);

  const sus: Point[] = hrs.map((h) => [h.i, h.s ?? '-']);
  const gust: Point[] = hrs.map((h) => [h.i, h.g ?? '-']);
  const bandBase: Point[] = hrs.map((h) => [h.i, h.s != null && h.g != null ? h.s : '-']);
  const band: Point[] = hrs.map((h) => [h.i, h.s != null && h.g != null ? Math.max(0, h.g - h.s) : '-']);

  const midnights = hrs.filter((h) => h.hour === 0 && h.i > v.a && h.i < v.b);

  const arrows = [];
  for (let i = v.a + Math.floor(v.arrowStep / 2); i <= v.b; i += v.arrowStep) {
    const h = hrs[i];
    if (!h || h.dir == null) continue;
    const mph = toMph(h.s ?? 0, v.unit);
    arrows.push({
      value: [i, 0],
      // ECharts rotates counter-clockwise; compass bearings run clockwise.
      symbolRotate: -((h.dir + 180) % 360),
      symbolSize: Math.round(10 + Math.min(8, mph / 5)),
      itemStyle: { color: levelFor(mph, v.windyMph).color },
    });
  }

  const hourLabel = (val: number): string => {
    const idx = Math.round(val);
    const h = hrs[idx];
    if (h) return hourShort(h.hour);
    const last = hrs[hrs.length - 1];
    return last ? hourShort(last.hour + (idx - last.i)) : '';
  };

  // Each day's name sits in the middle of the part of that day that's on screen
  // (skipped if less than 6 hours of it is visible).
  const dayAt = new Map<number, string>();
  for (const d of model.days) {
    const from = Math.max(d.start, v.a);
    const to = Math.min(d.end - 1, v.b);
    if (to - from < 6) continue;
    const name = d.index === 0 ? 'Today' : d.weekday;
    dayAt.set(Math.round((from + to) / 2), v.longDayLabels ? `${name} ${d.dateLabel}` : name);
  }
  const dayLabel = (val: number): string => dayAt.get(val) ?? '';

  const lowConfidenceFrom = model.days.find((d) => d.lowConfidence)?.start;
  const showLowConf = lowConfidenceFrom != null && v.b > lowConfidenceFrom;

  const unitLabel = UNIT_LABEL[v.unit];
  const fontSize = v.hourStep >= 12 ? 9 : 10;

  // outerBoundsMode 'none': both grids must stay exactly the same width so the
  // hour axis lines up with the plot (ECharts 6 otherwise shrinks a grid to fit labels).
  const plotGrid = { left: 44, right: 14, top: 26, height: 140, outerBoundsMode: 'none' };
  const arrowGrid = { left: 44, right: 14, top: 170, height: 22, outerBoundsMode: 'none' };

  return {
    animation: false,
    textStyle: { fontFamily: FONT },
    grid: [plotGrid, arrowGrid],
    tooltip: {
      trigger: 'axis',
      showContent: false,
      axisPointer: { type: 'line', lineStyle: { color: C.cursor, opacity: 0.6, width: 1 }, label: { show: false } },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { show: false } },
    xAxis: [
      // Plot area: no labels of its own; the hour axis below carries them.
      {
        gridIndex: 0,
        type: 'value',
        min: v.a,
        max: v.b,
        interval: v.hourStep,
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
        splitLine: { show: false },
      },
      // Hour axis: a tick and a value every hourStep hours.
      {
        gridIndex: 1,
        type: 'value',
        min: v.a,
        max: v.b,
        interval: v.hourStep,
        position: 'bottom',
        axisLine: { show: true, lineStyle: { color: C.axis } },
        axisTick: { show: true, length: 5, lineStyle: { color: C.axis } },
        axisLabel: { show: true, color: C.label, fontSize, margin: 7, formatter: hourLabel, showMinLabel: true, showMaxLabel: true },
        splitLine: { show: false },
      },
      // Day axis: names under each day's noon. No tick marks, so nothing goes unlabelled.
      {
        gridIndex: 1,
        type: 'value',
        min: v.a,
        max: v.b,
        interval: 1,
        position: 'bottom',
        offset: 22,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: true, color: C.text, fontSize: 11, fontWeight: 600, formatter: dayLabel },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        gridIndex: 0,
        type: 'value',
        min: 0,
        max: yMax,
        interval: yStep,
        name: unitLabel,
        nameLocation: 'end',
        nameGap: 10,
        nameTextStyle: { color: C.label, fontWeight: 600, fontSize: 10, align: 'right' },
        axisLine: { show: true, lineStyle: { color: C.axis } },
        axisTick: { show: true, length: 5, lineStyle: { color: C.axis } },
        axisLabel: { color: C.label, fontSize: 10, margin: 7 },
        splitLine: { show: true, lineStyle: { color: C.grid } },
      },
      { gridIndex: 1, type: 'value', min: -1, max: 1, show: false },
    ],
    series: [
      {
        name: 'band-base',
        type: 'line',
        data: bandBase,
        stack: 'band',
        symbol: 'none',
        silent: true,
        lineStyle: { opacity: 0 },
        tooltip: { show: false },
      },
      {
        name: 'Gust range',
        type: 'line',
        data: band,
        stack: 'band',
        symbol: 'none',
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { color: C.orange, opacity: 0.12 },
      },
      {
        name: 'Gusts',
        type: 'line',
        data: gust,
        showSymbol: false,
        symbolSize: 7,
        itemStyle: { color: C.orange, borderColor: '#0E151C', borderWidth: 2 },
        lineStyle: { color: C.orange, width: 1.6, type: [4, 3] },
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          animation: false,
          data: [
            {
              yAxis: v.gustLimit,
              lineStyle: { color: C.limit, type: [6, 4], width: 1.5, opacity: 1 },
              label: { formatter: `Gust limit ${v.gustLimit} ${unitLabel}`, position: 'insideEndTop', color: C.limitText, fontSize: 10 },
            },
          ],
        },
      },
      {
        name: 'Sustained',
        type: 'line',
        data: sus,
        showSymbol: false,
        symbolSize: 7,
        itemStyle: { color: C.blue, borderColor: '#0E151C', borderWidth: 2 },
        lineStyle: { color: C.blue, width: 3 },
        areaStyle: { color: C.blue, opacity: 0.14 },
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          animation: false,
          data: [
            ...midnights.map((h) => ({ xAxis: h.i, lineStyle: { color: C.midnight, type: 'solid', width: 1 }, label: { show: false } })),
            ...(v.nowIdx >= v.a && v.nowIdx <= v.b
              ? [
                  {
                    xAxis: v.nowIdx,
                    lineStyle: { color: 'rgba(230,237,243,0.55)', type: [2, 3], width: 1 },
                    label: { show: true, formatter: 'Now', position: 'end', color: C.text, fontSize: 10 },
                  },
                ]
              : []),
          ],
        },
        markArea: showLowConf
          ? {
              silent: true,
              data: [
                [
                  {
                    xAxis: Math.max(lowConfidenceFrom!, v.a),
                    name: 'Lower confidence',
                    itemStyle: { color: 'rgba(10,16,22,0.45)' },
                    label: { color: C.muted, fontSize: 10, position: 'insideTop' },
                  },
                  { xAxis: v.b },
                ],
              ],
            }
          : undefined,
      },
      {
        name: 'Direction',
        type: 'scatter',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: arrows,
        symbol: ARROW,
        symbolKeepAspect: true,
        silent: true,
      },
    ],
  };
}

export interface ChartHandle {
  render(model: Model, view: ChartView): void;
  resize(): void;
}

export function createChart(el: HTMLElement, onHover: (idx: number | null) => void): ChartHandle {
  const chart = echarts.init(el, undefined, { renderer: 'canvas' });
  chart.on('updateAxisPointer', (e: unknown) => {
    const info = (e as { axesInfo?: { axisDim: string; value: number }[] }).axesInfo?.find((x) => x.axisDim === 'x');
    if (info && Number.isFinite(info.value)) onHover(Math.round(info.value));
  });
  chart.getZr().on('globalout', () => onHover(null));
  return {
    render: (model, view) => chart.setOption(buildOption(model, view), { notMerge: true }),
    resize: () => chart.resize(),
  };
}
