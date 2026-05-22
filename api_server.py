#!/usr/bin/env python3
"""
api_server.py — Live RRG computation backend for NSE sectors.
Fetches data from OpenAlgo and computes relative rotation metrics on demand.
"""
import time
import hashlib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from openalgo import api
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

PROJECT_ROOT = Path(__file__).resolve().parent
SHARED_OPENALGO_ROOT = PROJECT_ROOT.parent / "openalgo"

# ── Load .env ──
load_dotenv(SHARED_OPENALGO_ROOT / ".env", override=False)
load_dotenv(SHARED_OPENALGO_ROOT / ".env.local", override=False)
load_dotenv(PROJECT_ROOT / ".env", override=True)
load_dotenv(PROJECT_ROOT / ".env.local", override=True)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Serve frontend static files ──
_static_dir = os.path.dirname(os.path.abspath(__file__))

# ── OpenAlgo client ──
OPENALGO_API_KEY = os.environ.get("OPENALGO_API_KEY")
OPENALGO_HOST = os.environ.get("OPENALGO_HOST", "http://127.0.0.1:5000")
client = api(api_key=OPENALGO_API_KEY, host=OPENALGO_HOST)

# ── In-memory cache (key -> {data, timestamp}) ──
_price_cache = {}
CACHE_TTL = 300  # 5 minutes

# ── Load sector holdings ──
_holdings_path = os.path.join(os.path.dirname(__file__), "sector_holdings.json")
with open(_holdings_path) as _f:
    SECTOR_HOLDINGS = json.load(_f)

# NSE Index sectors
DEFAULT_SECTORS = {
    "NIFTYIT": {"name": "IT", "color": "#00BCD4"},
    "NIFTYAUTO": {"name": "Auto", "color": "#2196F3"},
    "NIFTYPHARMA": {"name": "Pharma", "color": "#E91E63"},
    "NIFTYENERGY": {"name": "Energy", "color": "#FF5722"},
    "NIFTYFMCG": {"name": "FMCG", "color": "#8BC34A"},
    "NIFTYMETAL": {"name": "Metal", "color": "#795548"},
    "NIFTYREALTY": {"name": "Realty", "color": "#009688"},
    "NIFTYPVTBANK": {"name": "Pvt Bank", "color": "#9C27B0"},
    "NIFTYPSUBANK": {"name": "PSU Bank", "color": "#FF9800"},
    "NIFTYMEDIA": {"name": "Media", "color": "#F7931A"},
    "NIFTYINFRA": {"name": "Infra", "color": "#9E9E9E"},
    "NIFTYCOMMODITIES": {"name": "Commodities", "color": "#FFEB3B"},
}

BENCHMARKS = {
    "NIFTY": "Nifty 50",
    "BANKNIFTY": "NIFTY BANK",
    "FINNIFTY": "NIFTY FIN SERVICE",
    "NIFTY500": "Nifty 500",
    "NIFTYNXT50": "Nifty Next 50",
    "MIDCPNIFTY": "Midcap Nifty",
}

BENCHMARK_ALIASES = {
    "NIFTY 50": "NIFTY",
    "NIFTY BANK": "BANKNIFTY",
    "NIFTY FIN SERVICE": "FINNIFTY",
    "NIFTY NEXT 50": "NIFTYNXT50",
    "MIDCAP NIFTY": "MIDCPNIFTY",
    "NIFTY 500": "NIFTY500",
    "BANK NIFTY": "BANKNIFTY",
    "FIN NIFTY": "FINNIFTY",
}

# Default tracked assets (beyond sector indices) — currently none
DEFAULT_EXTRAS = {}

# Extra colors for user-added symbols
EXTRA_COLORS = [
    "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7",
    "#DDA0DD", "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9",
    "#F8C471", "#82E0AA", "#F1948A", "#AED6F1", "#D2B4DE",
]
_color_index = 0


def _get_next_color():
    global _color_index
    c = EXTRA_COLORS[_color_index % len(EXTRA_COLORS)]
    _color_index += 1
    return c


def _cache_key(symbols, start_date, end_date):
    raw = f"{sorted(symbols)}:{start_date}:{end_date}"
    return hashlib.md5(raw.encode()).hexdigest()


# All known NSE_INDEX symbols
NSE_INDEX_SYMBOLS = {
    "NIFTY", "NIFTYNXT50", "FINNIFTY", "BANKNIFTY", "MIDCPNIFTY", "INDIAVIX",
    "NIFTY100", "NIFTY200", "NIFTY500", "NIFTYALPHA50", "NIFTYAUTO",
    "NIFTYCOMMODITIES", "NIFTYCONSUMPTION", "NIFTYCPSE", "NIFTYDIVOPPS50",
    "NIFTYENERGY", "NIFTYFMCG", "NIFTYGROWSECT15", "NIFTYINFRA", "NIFTYIT",
    "NIFTYMEDIA", "NIFTYMETAL", "NIFTYMIDCAP100", "NIFTYMIDCAP150",
    "NIFTYMIDCAP50", "NIFTYMIDSML400", "NIFTYMNC", "NIFTYPHARMA",
    "NIFTYPSE", "NIFTYPSUBANK", "NIFTYPVTBANK", "NIFTYREALTY",
    "NIFTYSERVSECTOR", "NIFTYSMLCAP100", "NIFTYSMLCAP250", "NIFTYSMLCAP50",
    "NIFTY100EQLWGT", "NIFTY100LIQ15", "NIFTY100LOWVOL30", "NIFTY100QUALTY30",
    "NIFTY200QUALTY30", "NIFTY50EQLWGT", "NIFTY50VALUE20",
}

SYMBOL_ALIAS_MAP = {
    "TMCV": "TMPV",
    "TATAMOTORS": "TMPV",
}


def _resolve_symbol_alias(symbol):
    return SYMBOL_ALIAS_MAP.get(symbol, symbol)


def _resolve_benchmark(symbol):
    """Map friendly benchmark labels back to canonical symbol ids."""
    raw = (symbol or "").strip().upper()
    if not raw:
        return "NIFTY"
    return BENCHMARK_ALIASES.get(raw, raw.replace(" ", ""))


def _get_exchange(symbol):
    """Determine exchange for a symbol."""
    if symbol in NSE_INDEX_SYMBOLS:
        return "NSE_INDEX"
    return "NSE"


def _history_result_to_dataframe(result):
    """Best-effort normalize OpenAlgo history responses to a DataFrame.

    OpenAlgo usually returns a DataFrame, but some failure paths return a
    plain dict payload. Treat those as empty unless they contain row data.
    """
    if result is None:
        return None

    if isinstance(result, pd.DataFrame):
        return result

    if isinstance(result, dict):
        rows = result.get("data")
        if isinstance(rows, pd.DataFrame):
            return rows
        if isinstance(rows, list) and rows:
            try:
                df = pd.DataFrame(rows)
            except Exception:
                return None
            return df if not df.empty else None

    return None


def fetch_prices(symbols, start_date=None, end_date=None):
    """Fetch daily close prices from OpenAlgo, resample to weekly, with caching."""
    if end_date is None:
        end_date = datetime.now().strftime("%Y-%m-%d")
    if start_date is None:
        # Use a longer lookback so tails above 52w still have enough weekly bars
        # after the 52-week rolling warmup.
        start_date = (datetime.now() - timedelta(days=1825)).strftime("%Y-%m-%d")

    key = _cache_key(symbols, start_date, end_date)
    now = time.time()

    if key in _price_cache and (now - _price_cache[key]["ts"]) < CACHE_TTL:
        return _price_cache[key]["data"]

    all_close = pd.DataFrame()

    for sym in symbols:
        try:
            resolved_sym = _resolve_symbol_alias(sym)
            exchange = _get_exchange(resolved_sym)
            df = client.history(
                symbol=resolved_sym,
                exchange=exchange,
                interval="D",
                start_date=start_date,
                end_date=end_date,
            )
            df = _history_result_to_dataframe(df)
            if df is not None and not df.empty and "close" in df.columns:
                # Ensure index is datetime
                if not isinstance(df.index, pd.DatetimeIndex):
                    df.index = pd.to_datetime(df.index)
                # Strip timezone for consistency
                if df.index.tz is not None:
                    df.index = df.index.tz_localize(None)
                all_close[sym] = df["close"]
        except Exception as exc:
            print(f"Warning: Could not fetch data for {sym}: {exc}")
            continue

    if all_close.empty:
        raise HTTPException(status_code=404, detail="No data returned for the given symbols")

    # Resample daily to weekly (Friday close)
    weekly = all_close.resample("W-FRI").last().dropna(how="all")

    _price_cache[key] = {"data": weekly, "ts": now}
    return weekly


def compute_single_rrg(sector_prices, benchmark_prices, tail_length=8):
    """Compute RS-Ratio and RS-Momentum for one symbol vs benchmark."""
    raw_rs = (sector_prices / benchmark_prices) * 100
    rs_smoothed = raw_rs.ewm(span=10, adjust=False).mean()

    rolling_mean = rs_smoothed.rolling(window=52, min_periods=20).mean()
    rolling_std = rs_smoothed.rolling(window=52, min_periods=20).std()

    # Avoid division by zero
    rolling_std = rolling_std.replace(0, np.nan)
    rs_ratio = 100 + ((rs_smoothed - rolling_mean) / rolling_std) * 2

    rs_momentum_raw = rs_ratio - rs_ratio.shift(1)
    mom_smoothed = rs_momentum_raw.ewm(span=5, adjust=False).mean()
    mom_mean = mom_smoothed.rolling(window=52, min_periods=20).mean()
    mom_std = mom_smoothed.rolling(window=52, min_periods=20).std()
    mom_std = mom_std.replace(0, np.nan)
    rs_momentum = 100 + ((mom_smoothed - mom_mean) / mom_std) * 2

    valid = rs_ratio.notna() & rs_momentum.notna()
    rs_r = rs_ratio[valid]
    rs_m = rs_momentum[valid]

    if len(rs_r) == 0:
        return None

    n = min(tail_length, len(rs_r))
    tail = []
    for i in range(-n, 0):
        tail.append({
            "date": rs_r.index[i].strftime("%Y-%m-%d"),
            "rs_ratio": round(float(rs_r.iloc[i]), 2),
            "rs_momentum": round(float(rs_m.iloc[i]), 2),
        })

    current = tail[-1] if tail else None
    if current:
        r, m = current["rs_ratio"], current["rs_momentum"]
        if r >= 100 and m >= 100:
            quadrant = "Leading"
        elif r >= 100 and m < 100:
            quadrant = "Weakening"
        elif r < 100 and m >= 100:
            quadrant = "Improving"
        else:
            quadrant = "Lagging"
    else:
        quadrant = "Unknown"

    return {"tail": tail, "current": current, "quadrant": quadrant}


# ── Endpoints ──

@app.get("/api/rrg")
def get_rrg(
    benchmark: str = Query("NIFTY"),
    tail: int = Query(52, ge=4, le=156),
    extra: str = Query("", description="Comma-separated extra symbols"),
):
    """Compute full RRG for all sectors + any extra symbols vs the given benchmark."""
    benchmark = _resolve_benchmark(benchmark)

    # Parse extra symbols
    extra_symbols = []
    if extra:
        extra_symbols = [s.strip().upper() for s in extra.split(",") if s.strip()]

    # Build symbol list
    default_extra_syms = [s for s in DEFAULT_EXTRAS if s != benchmark]
    all_symbols = list(DEFAULT_SECTORS.keys()) + [benchmark] + default_extra_syms + extra_symbols
    all_symbols = list(dict.fromkeys(all_symbols))  # deduplicate

    close = fetch_prices(all_symbols)

    if benchmark not in close.columns:
        raise HTTPException(status_code=404, detail=f"Benchmark {benchmark} not found in data")

    bench_prices = close[benchmark]

    results = {}

    # Compute for default sectors
    for sym, meta in DEFAULT_SECTORS.items():
        if sym not in close.columns:
            continue
        rrg = compute_single_rrg(close[sym], bench_prices, tail_length=tail)
        if rrg:
            results[sym] = {
                "symbol": sym,
                "name": meta["name"],
                "color": meta["color"],
                "isDefault": True,
                **rrg,
            }

    # Compute for default extras
    for sym, meta in DEFAULT_EXTRAS.items():
        if sym == benchmark:
            continue
        if sym not in close.columns:
            continue
        rrg = compute_single_rrg(close[sym], bench_prices, tail_length=tail)
        if rrg:
            results[sym] = {
                "symbol": sym,
                "name": meta["name"],
                "color": meta["color"],
                "isDefault": True,
                **rrg,
            }

    # Compute for user-added extra symbols
    for sym in extra_symbols:
        if sym in DEFAULT_SECTORS or sym in DEFAULT_EXTRAS or sym == benchmark:
            continue
        if sym not in close.columns:
            continue
        rrg = compute_single_rrg(close[sym], bench_prices, tail_length=tail)
        if rrg:
            results[sym] = {
                "symbol": sym,
                "name": sym,
                "color": _get_next_color(),
                "isDefault": False,
                **rrg,
            }

    latest_date = None
    for sym, d in results.items():
        if d["tail"]:
            latest_date = d["tail"][-1]["date"]
            break

    return {
        "benchmark": benchmark,
        "benchmark_name": BENCHMARKS.get(benchmark, benchmark),
        "tail_length": tail,
        "latest_data_date": latest_date,
        "computed_at": datetime.now().isoformat(),
        "sectors": results,
    }


@app.get("/api/holdings")
def get_holdings():
    """Return sector holdings metadata (no price data)."""
    return SECTOR_HOLDINGS


@app.get("/api/rrg-stocks")
def get_rrg_stocks(
    symbols: str = Query(..., description="Comma-separated stock symbols"),
    benchmark: str = Query("NIFTY"),
    tail: int = Query(52, ge=4, le=156),
):
    """Compute RRG for a batch of individual stocks vs benchmark."""
    benchmark = _resolve_benchmark(benchmark)
    stock_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not stock_list:
        raise HTTPException(status_code=422, detail="No symbols provided")

    all_symbols = stock_list + [benchmark]
    all_symbols = list(dict.fromkeys(all_symbols))

    close = fetch_prices(all_symbols)

    if benchmark not in close.columns:
        raise HTTPException(status_code=404, detail=f"Benchmark {benchmark} not found")

    bench_prices = close[benchmark]
    results = {}

    for sym in stock_list:
        if sym == benchmark or sym not in close.columns:
            continue
        rrg = compute_single_rrg(close[sym], bench_prices, tail_length=tail)
        if rrg:
            results[sym] = {
                "symbol": sym,
                "name": sym,
                **rrg,
            }

    return {
        "benchmark": benchmark,
        "tail_length": tail,
        "computed_at": datetime.now().isoformat(),
        "stocks": results,
    }


class PortfolioRequest(BaseModel):
    symbols: list[str]
    benchmark: str = "NIFTY"
    tail: int = 52


@app.post("/api/rrg-portfolio")
def get_rrg_portfolio(req: PortfolioRequest):
    """Compute RRG for an equal-weighted portfolio composite vs benchmark."""
    benchmark = _resolve_benchmark(req.benchmark)
    stock_list = [s.strip().upper() for s in req.symbols if s.strip()]
    tail_length = max(4, min(156, req.tail))

    if not stock_list or len(stock_list) < 1:
        raise HTTPException(status_code=422, detail="Portfolio needs at least 1 symbol")

    all_symbols = stock_list + [benchmark]
    all_symbols = list(dict.fromkeys(all_symbols))

    close = fetch_prices(all_symbols)

    if benchmark not in close.columns:
        raise HTTPException(status_code=404, detail=f"Benchmark {benchmark} not found")

    # Build equal-weighted composite: average of normalised returns
    available = [s for s in stock_list if s in close.columns and s != benchmark]
    if not available:
        raise HTTPException(status_code=404, detail="No valid stock data for portfolio")

    # Normalise each stock to its first non-NaN value, then average
    normed = pd.DataFrame(index=close.index)
    for sym in available:
        prices = close[sym].dropna()
        if len(prices) < 20:
            continue
        normed[sym] = prices / prices.iloc[0] * 100

    if normed.empty or normed.shape[1] == 0:
        raise HTTPException(status_code=404, detail="Insufficient data for portfolio")

    composite = normed.mean(axis=1).dropna()
    bench_prices = close[benchmark]

    # Align indices
    common_idx = composite.index.intersection(bench_prices.dropna().index)
    composite = composite.loc[common_idx]
    bench_aligned = bench_prices.loc[common_idx]

    rrg = compute_single_rrg(composite, bench_aligned, tail_length=tail_length)
    if not rrg:
        raise HTTPException(status_code=404, detail="Could not compute RRG for portfolio")

    return {
        "benchmark": benchmark,
        "tail_length": tail_length,
        "computed_at": datetime.now().isoformat(),
        "portfolio": rrg,
        "symbols_used": list(normed.columns),
    }


class ValidateRequest(BaseModel):
    symbol: str


@app.post("/api/validate-symbol")
def validate_symbol(req: ValidateRequest):
    """Check if a symbol is valid by attempting to fetch its data."""
    sym = req.symbol.strip().upper()
    if not sym:
        raise HTTPException(status_code=422, detail="Empty symbol")
    try:
        resolved_sym = _resolve_symbol_alias(sym)
        exchange = _get_exchange(resolved_sym)
        end_date = datetime.now().strftime("%Y-%m-%d")
        start_date = (datetime.now() - timedelta(days=10)).strftime("%Y-%m-%d")
        df = client.history(
            symbol=resolved_sym,
            exchange=exchange,
            interval="D",
            start_date=start_date,
            end_date=end_date,
        )
        df = _history_result_to_dataframe(df)
        if df is None or df.empty:
            raise HTTPException(status_code=404, detail=f"No data found for {sym}")
        return {"symbol": sym, "name": sym, "valid": True}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail=f"Symbol {sym} not found")


@app.get("/api/health")
def health():
    return {"status": "ok", "time": datetime.now().isoformat()}


# ── Serve frontend ──

@app.get("/")
def serve_index():
    return FileResponse(os.path.join(_static_dir, "index.html"))


@app.get("/{filename:path}")
def serve_static(filename: str):
    filepath = os.path.join(_static_dir, filename)
    if os.path.isfile(filepath):
        return FileResponse(filepath)
    raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("SECTOR_ROTATION_PORT", os.environ.get("PORT", "8002")))
    uvicorn.run(app, host="0.0.0.0", port=port)
