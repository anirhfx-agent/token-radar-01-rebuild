#!/usr/bin/env python3
"""Build data/snapshot.json — the frozen snapshot for Token Radar.

Reads the live DefiLlama /protocols endpoint and the CoinGecko /coins/list
endpoint (fetched once, saved to /tmp), then applies the watchlist filter
and writes the compact snapshot that main.ts consumes. Run once; the output
is committed to the repo so main.ts runs with no network access.

Watchlist filter (each rule is documented in the snapshot meta note):
  - no token recorded (no gecko_id and no cmcId)
  - TVL > $1M
  - not CEX / Bridge / Canonical Bridge / Chain / Interface
  - parent project not tokenised (DefiLlama sibling/gecko, or CoinGecko
    id/name on the parent slug including suffix-stripped bases, or the
    documented data-gap exclusions curve-finance -> CRV, justlend -> JST)
  - not a wrapped or staked product by name
Peers (used to fit the mcap/TVL multiple):
  - has a token (gecko_id or cmcId), has a market cap, and TVL > $10,000.
    The $10k floor removes dust-TVL protocols whose mcap/TVL ratio is
    meaningless (e.g. a $17M mcap on ~$0 TVL = 286,000x) and would
    otherwise skew the category medians badly.
Category stats (for token-odds base rates) cover ALL protocols.
"""
import json, re
from collections import Counter

DL = '/tmp/defillama-protocols.json'
CG = '/tmp/coingecko-list.json'
OUT = 'data/snapshot.json'

d = json.load(open(DL))
coins = json.load(open(CG))
cg_ids = {c['id'] for c in coins}
cg_names = {c['name'].lower(): c['id'] for c in coins}

def has_token(p):
    return bool(p.get('gecko_id') or p.get('cmcId'))

def parent_slug(p):
    pp = p.get('parentProtocol')
    return pp.split('#', 1)[1] if pp and '#' in pp else None

def base_names(slug):
    out = {slug}
    for suf in ['-finance', '-dao', '-protocol', '-labs', '-network', '-fi']:
        if slug.endswith(suf):
            out.add(slug[:-len(suf)])
    out.add(slug.split('-')[0])
    return out

def parent_tokenized(ps):
    if not ps:
        return False
    for b in base_names(ps):
        if b in cg_ids:
            return True
        if b.replace('-', ' ') in cg_names:
            return True
    return False

dl_tokenized = set()
for p in d:
    if has_token(p):
        ps = parent_slug(p)
        if ps:
            dl_tokenized.add(ps)
        if p.get('gecko_id'):
            dl_tokenized.add(p['gecko_id'])

# Documented data-gap exclusions (verified on CoinGecko; their CoinGecko ids
# do not match the DefiLlama parent slug by id or name):
#  - curve-finance -> CRV (CoinGecko id 'curve-dao-token', name 'Curve DAO')
#  - justlend      -> JST (CoinGecko id 'just', symbol JST)
EXPLICIT = {'curve-finance', 'justlend'}

def is_tokenized_parent(ps):
    if not ps:
        return False
    if ps in dl_tokenized:
        return True
    if ps in EXPLICIT:
        return True
    return parent_tokenized(ps)

# Explicit exclusions from the radar (slug -> reason). A token-launch radar
# ranks protocols that could launch a token; a protocol whose flagship
# product IS a stablecoin has nothing left to launch — the stablecoin
# already exists. Kelp is excluded for a different reason: its governance
# token cannot be identified in the data at all. The same list is guarded
# in main.ts so a stale snapshot stays correct.
EXCLUDED_SLUGS = {
    'usdd': 'USDD stablecoin itself',
    'kelp': 'no identifiable governance token in the data',
    'm0': 'stablecoin infrastructure (Stablecoin Issuer)',
    'saturn': 'USD-at stablecoin wrapper (Stablecoin Wrapper)',
    'usdcx': 'USDCx stablecoin (Stablecoin Wrapper)',
    'hylo-protocol': 'hyUSD stable asset (Dual-Token Stablecoin)',
    'rif-on-chain': 'USDRIF stablecoin (Dual-Token Stablecoin)',
    'djed-stablecoin': 'Djed stablecoin (Dual-Token Stablecoin)',
    'usdr': 'USDR T-bill-backed stablecoin (Stablecoin Wrapper)',
    'yuzu-money': 'overcollateralized stablecoin (per its own description)',
    'tori-finance': 'synthetic dollar protocol — trUSD is the product',
    'axis': 'issues USDx, a synthetic dollar',
    'mountain-protocol': 'USDM yield-bearing stable coin',
    'theo-network-thusd': 'thUSD yield-bearing stablecoin',
    'hermetica-usdh': 'synthetic dollar protocol (USDh)',
    'monetrix-usdm': 'yield-bearing stable token (USDM)',
    'international-stable-currency': 'yield-bearing stablecoin (ISC)',
    'decentralized-euro': 'dEURO EURO stablecoin',
}

EXCLUDE_CAT = {'CEX', 'Bridge', 'Canonical Bridge', 'Chain', 'Interface'}

def is_wrapped_name(name):
    n = name.lower()
    if 'wrapped' in n:
        return True
    if re.search(r'\bstaked\b', n):
        return True
    if re.match(r'^(w|st)[A-Z]', name):
        return True
    if re.search(r'\b(wbtc|weth|wbnb|steth|reth|cbeth|wsteth)\b', n):
        return True
    return False

cat_tot, cat_tok = Counter(), Counter()
for p in d:
    c = p.get('category') or 'Unknown'
    cat_tot[c] += 1
    if has_token(p):
        cat_tok[c] += 1
cat_stats = {c: {'total': cat_tot[c], 'withToken': cat_tok[c]} for c in cat_tot}

watch, peers = [], []
for p in d:
    if has_token(p):
        # Peer quality floor: TVL > $10k. Without it, dust-TVL protocols
        # produce meaningless mcap/TVL ratios (up to 286,000x) that skew
        # the category medians.
        if p.get('mcap') and (p.get('tvl') or 0) > 1e4:
            peers.append(p)
        continue
    if (p.get('tvl') or 0) <= 1e6:
        continue
    if p.get('category') in EXCLUDE_CAT:
        continue
    if is_tokenized_parent(parent_slug(p)):
        continue
    if is_wrapped_name(p['name']):
        continue
    if p['slug'] in EXCLUDED_SLUGS:
        continue
    watch.append(p)

def compact_peer(p):
    return {'s': p['slug'], 'n': p['name'], 'c': p['category'],
            't': round(p['tvl'], 2), 'm': round(p['mcap'], 2)}

def compact_watch(p):
    return {'s': p['slug'], 'n': p['name'], 'c': p['category'], 't': round(p['tvl'], 2),
            'ch': p.get('chain'), 'nc': len(p.get('chains') or []), 'a': int(p.get('audits') or 0),
            'p': parent_slug(p), 'la': p.get('listedAt'),
            'u': p.get('url'), 'tw': bool(p.get('twitter')),
            'd': (p.get('description') or '')[:220], 'f': bool(p.get('forkedFrom'))}

snap = {
    'meta': {
        'source': 'DefiLlama /protocols + CoinGecko /coins/list',
        'fetched_at': '2026-11-23T16:57:00Z',
        'note': ('Frozen snapshot. Watchlist = no token (no gecko_id/cmcId), TVL>$1M, '
                 'not CEX/Bridge/Chain/Interface, parent not tokenized (DefiLlama sibling/gecko, '
                 'or CoinGecko id/name incl. suffix-stripped base, or documented curve-finance/justlend), '
                 'not a wrapped/staked product by name, and not a stablecoin product itself '
                 '(18 explicit exclusions, e.g. USDD; plus Kelp, no identifiable governance token). '
                 'Peers = token protocols with mcap and TVL>$10k, '
                 'used to fit the value multiple (the $10k floor removes dust-TVL ratios). '
                 'categoryStats = per-category totals for token-odds base rates.'),
        'counts': {'protocols_total': len(d), 'watchlist': len(watch), 'peers': len(peers)},
    },
    'categoryStats': cat_stats,
    'peers': [compact_peer(p) for p in peers],
    'watchlist': [compact_watch(p) for p in watch],
}

import os
with open(OUT, 'w') as f:
    json.dump(snap, f, separators=(',', ':'))
print(f"WATCHLIST: {len(watch)} | PEERS: {len(peers)} | snapshot bytes: {os.path.getsize(OUT)}")
print("top 10 by TVL:")
for p in sorted(watch, key=lambda x: -x['tvl'])[:10]:
    print(f"  {p['name']} | {p['category']} | ${p['tvl']/1e6:.0f}M | parent={p.get('parentProtocol')}")
