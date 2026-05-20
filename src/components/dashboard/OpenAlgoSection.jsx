import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CircleCheckBig, Loader2, Server, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getZerodhaStatus } from '@/lib/brokerClient';

export default function OpenAlgoSection() {
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['openalgo-status'],
    queryFn: () => getZerodhaStatus(),
    refetchInterval: 60000,
  });

  const openAlgoMode = data?.source === 'openalgo';
  const connected = Boolean(data?.connected);

  const cards = [
    {
      label: 'Mode',
      value: openAlgoMode ? 'OpenAlgo shared data' : 'Direct Zerodha',
      detail: openAlgoMode
        ? 'StockOne reads holdings, positions, quotes, and history through the shared OpenAlgo backend.'
        : 'StockOne is still using direct Zerodha access.',
    },
    {
      label: 'Broker session',
      value: connected ? 'Ready' : 'Disconnected',
      detail: connected
        ? 'The backend can fetch live broker data.'
        : 'Connect the broker session before syncing portfolio data.',
    },
    {
      label: 'Source',
      value: data?.profile?.user_name || 'OpenAlgo',
      detail: data?.profile?.email || 'Shared OpenAlgo environment',
    },
  ];

  return (
    <div className="rounded-[28px] border border-orange-200 bg-gradient-to-br from-white to-orange-50/70 p-5 shadow-[0_16px_40px_rgba(249,115,22,0.08)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-orange-500/80">OpenAlgo</p>
          <h3 className="mt-2 text-2xl font-semibold text-slate-900">Shared broker gateway</h3>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
            StockOne now acts as the dashboard shell while OpenAlgo stays the broker and market-data gateway. This keeps one Zerodha setup behind the scenes and lets every view reuse the same source.
          </p>
        </div>
        <div className="rounded-2xl border border-orange-200 bg-white p-3 text-orange-600">
          <Server className="h-5 w-5" />
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {cards.map((card) => (
          <div key={card.label} className="rounded-[22px] border border-slate-200 bg-white/90 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{card.label}</p>
            <p className="mt-3 text-lg font-semibold text-slate-900">{card.value}</p>
            <p className="mt-2 text-sm text-slate-500">{card.detail}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => refetch()}
          variant="outline"
          className="rounded-2xl border-orange-200 bg-white text-orange-700 hover:bg-orange-50"
        >
          <Loader2 className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {isLoading || isFetching ? 'Checking' : 'Refresh status'}
        </Button>
        <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${connected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
          {connected ? <CircleCheckBig className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {openAlgoMode ? 'OpenAlgo active' : 'Awaiting broker login'}
        </div>
        <div className="inline-flex items-center gap-2 rounded-full bg-orange-100 px-3 py-1 text-xs font-medium text-orange-700">
          <ShieldCheck className="h-3.5 w-3.5" />
          Single shared API key path
        </div>
      </div>

      {error ? <p className="mt-4 text-sm text-rose-600">{error.message}</p> : null}
    </div>
  );
}
