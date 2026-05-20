import React, { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Loader2, LogOut, RefreshCw, Send, ShieldCheck, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { disconnectZerodha, getBrokerApiBase, getZerodhaHoldings, getZerodhaLoginUrl, getZerodhaPositions, getZerodhaRedirectUrl, getZerodhaStatus, mapZerodhaHoldingToPortfolio, testTelegramAlert } from '@/lib/brokerClient';

export default function BrokerSyncPanel({ currentStocks = [], onSynced }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const brokerApiBase = getBrokerApiBase();
  const redirectUrl = getZerodhaRedirectUrl();
  const openAlgoMode = status?.source === 'openalgo';
  const usesHostedBroker = Boolean(brokerApiBase) && !/localhost|127\.0\.0\.1/i.test(brokerApiBase);
  const getHoldingKey = (row) => `${String(row?.exchange || 'NSE').trim().toUpperCase()}:${String(row?.symbol || '').trim().toUpperCase()}`;

  const currentSymbols = useMemo(
    () => new Set(currentStocks.map((stock) => getHoldingKey(stock))),
    [currentStocks],
  );
  const backendUnavailable = /backend unavailable|unable to reach broker backend|timed out/i.test(status?.error || '');

  const loadStatus = async () => {
    setLoading(true);
    try {
      const data = await getZerodhaStatus();
      setStatus(data);
    } catch (error) {
      setStatus({ configured: false, connected: false, unavailable: true, error: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const connect = async () => {
    try {
      const data = await getZerodhaLoginUrl(Capacitor.isNativePlatform() ? 'native' : 'web');
      window.location.assign(data.loginUrl);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const syncHoldings = async () => {
    setSyncing(true);
    try {
      const [holdingsData, positionsData] = await Promise.all([
        getZerodhaHoldings(),
        getZerodhaPositions().catch(() => ({ data: { net: [], day: [] } })),
      ]);

      const brokerHoldings = holdingsData?.data || [];
      let createdCount = 0;
      let updatedCount = 0;
      const diagnostics = [];
      const keyCounts = new Map();

      for (const item of brokerHoldings) {
        const mapped = mapZerodhaHoldingToPortfolio(item);
        const mappedKey = getHoldingKey(mapped);
        const existing = currentStocks.find((stock) => getHoldingKey(stock) === mappedKey);
        keyCounts.set(mappedKey, (keyCounts.get(mappedKey) || 0) + 1);

        diagnostics.push({
          key: mappedKey,
          exchange: mapped.exchange || item.exchange || '--',
          symbol: mapped.symbol || item.tradingsymbol || item.symbol || '--',
          companyName: mapped.name || item.company_name || '--',
          quantity: Number(item.quantity ?? item.used_quantity ?? item.t1_quantity ?? mapped.quantity ?? 0),
          averagePrice: Number(item.average_price ?? item.t1_average_price ?? mapped.buy_price ?? 0),
          lastPrice: Number(item.last_price ?? item.close_price ?? mapped.current_price ?? 0),
          isin: String(item.isin || '').trim() || '--',
          status: existing ? 'update' : 'create',
          queryHint: mappedKey,
          rawTradingSymbol: item.tradingsymbol || item.symbol || '--',
          rawExchange: item.exchange || '--',
        });

        if (existing) {
          updatedCount += 1;
          await base44.entities.Stock.update(existing.id, {
            ...existing,
            ...mapped,
            id: existing.id,
            created_date: existing.created_date,
          });
        } else {
          createdCount += 1;
          await base44.entities.Stock.create(mapped);
        }
      }

      const duplicateDiagnostics = diagnostics.filter((row) => (keyCounts.get(row.key) || 0) > 1);
      const reviewDiagnostics = diagnostics.filter((row) => (
        !row.symbol
        || row.symbol === '--'
        || !Number.isFinite(Number(row.quantity))
        || Number(row.quantity) <= 0
        || !['NSE', 'BSE'].includes(String(row.exchange || '').trim().toUpperCase())
        || (keyCounts.get(row.key) || 0) > 1
      ));
      const queryList = diagnostics.map((row) => row.queryHint);

      console.groupCollapsed('[StockOne] Zerodha holdings sync diagnostics');
      console.info('Counts', {
        rawHoldings: brokerHoldings.length,
        uniqueKeys: new Set(diagnostics.map((row) => row.key)).size,
        createdCount,
        updatedCount,
      });
      console.log('[StockOne] Zerodha query list:', queryList);
      console.table(diagnostics);
      if (duplicateDiagnostics.length) {
        console.warn('[StockOne] Duplicate Zerodha holding keys detected:');
        console.table(duplicateDiagnostics);
      }
      if (reviewDiagnostics.length) {
        console.warn('[StockOne] Review these holdings first:');
        console.table(reviewDiagnostics);
        console.log('[StockOne] Review query list:', reviewDiagnostics.map((row) => row.queryHint));
      }
      console.groupEnd();

      const netPositions = positionsData?.data?.net || [];
      toast.success(`Zerodha synced. ${createdCount} added, ${updatedCount} updated, ${netPositions.length} net positions fetched. Open console for the holding query list.`);
      await onSynced?.();
      await loadStatus();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectZerodha();
      toast.success('Zerodha session disconnected.');
      await loadStatus();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDisconnecting(false);
    }
  };

  const onTestTelegram = async () => {
    try {
      await testTelegramAlert();
      toast.success('Telegram P&L test message sent!');
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <section className="rounded-[32px] border border-white/10 bg-[#0b1624]/90 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-amber-200/80">Broker sync</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">{openAlgoMode ? 'OpenAlgo import' : 'Zerodha import'}</h2>
          <p className="mt-2 text-sm leading-7 text-slate-400">
            {openAlgoMode
              ? 'Fetch holdings, positions, quotes, and history through OpenAlgo, then merge them into the portfolio.'
              : 'Connect Kite Connect, fetch holdings and positions through the active backend, and merge them into the portfolio.'}
          </p>
          {Capacitor.isNativePlatform() ? (
            <p className="mt-2 text-sm leading-7 text-cyan-200/80">
              Android login opens Zerodha in the browser and should return to the installed app automatically after approval.
            </p>
          ) : null}
        </div>
        <div className="rounded-2xl border border-emerald-300/15 bg-emerald-300/10 p-3 text-emerald-200">
          <Wallet className="h-5 w-5" />
        </div>
      </div>

      <div className="mt-5 rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
        {loading ? (
          <div className="flex items-center gap-3 text-sm text-slate-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking Zerodha connection status...
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${status?.configured ? 'bg-cyan-400/15 text-cyan-200' : 'bg-rose-400/15 text-rose-200'}`}>
              {backendUnavailable ? 'Backend unavailable' : status?.configured ? (openAlgoMode ? 'OpenAlgo ready' : 'Configured') : 'Not configured'}
            </span>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${status?.connected ? 'bg-emerald-400/15 text-emerald-200' : 'bg-slate-400/15 text-slate-300'}`}>
                {status?.connected ? (openAlgoMode ? 'OpenAlgo connected' : 'Connected') : 'Disconnected'}
              </span>
              {status?.profile?.user_name ? (
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-300">
                  {status.profile.user_name} ({status.profile.user_id})
                </span>
              ) : null}
            </div>

            <div className="mt-4 text-sm text-slate-400">
              {backendUnavailable
                ? 'Broker backend is currently unavailable. Restart or redeploy the backend service, then retry.'
                : status?.connected
                ? `Ready to sync live holdings. Current local portfolio already contains ${currentSymbols.size} symbols.`
                : usesHostedBroker
                  ? 'Hosted backend is active. Add Zerodha credentials to the backend environment and then connect your account to fetch live broker data.'
                  : 'Add broker API credentials in your local .env and connect your account to fetch live broker data.'}
            </div>

            {status?.error ? <p className="mt-3 text-sm text-rose-300">{status.error}</p> : null}
          </>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={connect} disabled={loading || backendUnavailable || !status?.configured || status?.connected} className="rounded-2xl bg-amber-300 text-slate-950 hover:bg-amber-200">
          <ShieldCheck className="h-4 w-4" />
          Connect Zerodha
        </Button>
        <Button onClick={syncHoldings} disabled={loading || syncing || !status?.connected} variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Sync Holdings
        </Button>
        <Button onClick={onTestTelegram} disabled={loading || !status?.connected} variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
          <Send className="h-4 w-4" />
          Test Telegram
        </Button>
        <Button onClick={disconnect} disabled={loading || disconnecting || !status?.connected} variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
          <LogOut className="h-4 w-4" />
          Disconnect
        </Button>
      </div>

      <div className="mt-5 rounded-[24px] border border-white/8 bg-[#111c2c] p-4 text-sm text-slate-400">
        {usesHostedBroker ? 'Hosted backend active:' : 'Local backend active:'}
        <code className="mx-1 rounded bg-black/20 px-2 py-0.5 text-slate-200">{brokerApiBase || 'http://localhost:8000'}</code>
        {' '}with Zerodha redirect URL
        <code className="mx-1 rounded bg-black/20 px-2 py-0.5 text-slate-200">{redirectUrl}</code>.
        {!usesHostedBroker ? (
          <>
            {' '}Run <code className="mx-1 rounded bg-black/20 px-2 py-0.5 text-slate-200">npm run dev:server</code> for local broker testing.
          </>
        ) : null}
      </div>
    </section>
  );
}
