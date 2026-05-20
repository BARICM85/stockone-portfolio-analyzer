import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Compass, ExternalLink, Loader2, Radar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSectorRotationRrg } from '@/lib/brokerClient';

const SECTOR_ROTATION_APP_URL = import.meta.env.VITE_SECTOR_ROTATION_APP_URL || 'http://127.0.0.1:8000';

const QUADRANT_ORDER = {
  Leading: 4,
  Improving: 3,
  Weakening: 2,
  Lagging: 1,
  Benchmark: 0,
  Unknown: 0,
};

function scoreSector(entry = {}) {
  const quadrantScore = QUADRANT_ORDER[entry.quadrant] || 0;
  const ratio = Number(entry.current?.rs_ratio || 0);
  const momentum = Number(entry.current?.rs_momentum || 0);
  return quadrantScore * 1000 + ratio + momentum;
}

export default function SectorRotationSection() {
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['sector-rotation-rrg', 'NIFTY', 52],
    queryFn: () => getSectorRotationRrg({ benchmark: 'NIFTY', tail: 52 }),
    refetchInterval: 60000,
  });

  const sectors = Object.values(data?.sectors || {});
  const sortedSectors = [...sectors].sort((a, b) => scoreSector(b) - scoreSector(a));
  const quadrantCounts = sectors.reduce(
    (acc, sector) => {
      const key = sector.quadrant || 'Unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    { Leading: 0, Improving: 0, Weakening: 0, Lagging: 0 },
  );

  const topMovers = sortedSectors.slice(0, 4);
  const benchmark = data?.benchmark_name || data?.benchmark || 'NIFTY';
  const latestDate = data?.latest_data_date
    ? new Date(`${data.latest_data_date}T00:00:00`).toLocaleDateString('en-IN', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '--';

  const leading = sortedSectors.find((entry) => entry.quadrant === 'Leading');
  const improving = sortedSectors.find((entry) => entry.quadrant === 'Improving');
  const lagging = [...sortedSectors].reverse().find((entry) => entry.quadrant === 'Lagging');

  return (
    <div className="rounded-[28px] border border-cyan-200 bg-gradient-to-br from-white to-cyan-50/70 p-5 shadow-[0_16px_40px_rgba(6,182,212,0.08)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-600/80">Sector Rotation Map</p>
          <h3 className="mt-2 text-2xl font-semibold text-slate-900">Live RRG inside StockOne</h3>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
            This section reads the sector-rotation backend through StockOne, so the dashboard stays in one place while the RRG snapshot still comes from the shared OpenAlgo data path.
          </p>
        </div>
        <div className="rounded-2xl border border-cyan-200 bg-white p-3 text-cyan-600">
          <Compass className="h-5 w-5" />
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        {[
          { label: 'Benchmark', value: benchmark, detail: 'Sector rotation baseline' },
          { label: 'Updated', value: latestDate, detail: 'Latest RRG computation' },
          { label: 'Leading', value: String(quadrantCounts.Leading || 0), detail: 'Top-right quadrant' },
          { label: 'Improving', value: String(quadrantCounts.Improving || 0), detail: 'Momentum improving' },
        ].map((card) => (
          <div key={card.label} className="rounded-[22px] border border-slate-200 bg-white/90 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{card.label}</p>
            <p className="mt-3 text-lg font-semibold text-slate-900">{card.value}</p>
            <p className="mt-2 text-sm text-slate-500">{card.detail}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[24px] border border-slate-200 bg-white/90 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Quadrant summary</p>
              <p className="text-sm text-slate-500">Current count across all tracked sectors.</p>
            </div>
            <Radar className="h-5 w-5 text-cyan-600" />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              { label: 'Leading', value: quadrantCounts.Leading || 0, tone: 'text-emerald-600' },
              { label: 'Improving', value: quadrantCounts.Improving || 0, tone: 'text-cyan-600' },
              { label: 'Weakening', value: quadrantCounts.Weakening || 0, tone: 'text-amber-600' },
              { label: 'Lagging', value: quadrantCounts.Lagging || 0, tone: 'text-rose-600' },
            ].map((item) => (
              <div key={item.label} className="rounded-[20px] border border-slate-100 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.label}</p>
                <p className={`mt-2 text-2xl font-semibold ${item.tone}`}>{item.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {topMovers.map((entry) => (
              <div key={entry.symbol} className="rounded-[20px] border border-slate-100 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{entry.name || entry.symbol}</p>
                    <p className="text-sm text-slate-500">{entry.symbol}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-slate-900">{entry.quadrant || 'Unknown'}</p>
                    <p className="text-xs text-slate-500">
                      RS {Number(entry.current?.rs_ratio || 0).toFixed(2)} | Mom {Number(entry.current?.rs_momentum || 0).toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[
              { label: 'Top leader', value: leading?.name || leading?.symbol || '--' },
              { label: 'Improving watch', value: improving?.name || improving?.symbol || '--' },
              { label: 'Lagging watch', value: lagging?.name || lagging?.symbol || '--' },
            ].map((item) => (
              <div key={item.label} className="rounded-[20px] border border-slate-100 bg-white p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.label}</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{item.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex min-h-[520px] flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white/90">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Full map preview</p>
              <p className="text-sm text-slate-500">Open the standalone sector rotation view when you need the interactive chart.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => window.open(SECTOR_ROTATION_APP_URL, '_blank', 'noopener,noreferrer')}
              className="rounded-2xl border-cyan-200 bg-white text-cyan-700 hover:bg-cyan-50"
            >
              Open map
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
          <div className="relative flex-1 bg-slate-950">
            {isLoading || isFetching ? (
              <div className="absolute inset-0 flex items-center justify-center gap-3 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading sector rotation snapshot...
              </div>
            ) : (
              <iframe
                title="Sector rotation map"
                src={SECTOR_ROTATION_APP_URL}
                className="h-full w-full border-0"
              />
            )}
          </div>
        </div>
      </div>

      {error ? <p className="mt-4 text-sm text-rose-600">{error.message}</p> : null}
    </div>
  );
}
