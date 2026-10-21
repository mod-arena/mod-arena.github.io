// Port of ratings.py: Bradley-Terry ratings (MM algorithm) with a bootstrap interval, per group of compared policies.
(function () {
  const SCALE = 400 / Math.log(10), ANCHOR = 1000;

  function mmSolve(entities, comparisons, nIter = 500) {
    const n = entities.length;
    if (!n) return {};
    const idx = Object.fromEntries(entities.map((e, i) => [e, i]));
    const W = Array(n).fill(0), N = Array.from({ length: n }, () => Array(n).fill(0));
    for (const [a, b, o] of comparisons) {
      const i = idx[a], j = idx[b];
      if (i === undefined || j === undefined) continue;
      W[i] += o; W[j] += 1 - o; N[i][j]++; N[j][i]++;
    }
    let p = Array(n).fill(1);
    for (let it = 0; it < nIter; it++) {
      const np = p.slice();
      for (let i = 0; i < n; i++) {
        let denom = 0;
        for (let j = 0; j < n; j++) if (j !== i && N[i][j] > 0) denom += N[i][j] / (p[i] + p[j]);
        if (denom > 0) np[i] = W[i] > 0 ? W[i] / denom : 1e-8;
      }
      const s = np.reduce((x, y) => x + y, 0);
      if (s > 0) p = np.map(x => x / s * n);
    }
    return Object.fromEntries(entities.map((e, i) => [e, p[i]]));
  }

  function toElo(raw) {
    const keys = Object.keys(raw);
    if (!keys.length) return {};
    const logs = Object.fromEntries(keys.map(e => [e, Math.log(Math.max(raw[e], 1e-10))]));
    const vals = Object.values(logs).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    return Object.fromEntries(keys.map(e => [e, Math.round((logs[e] - med) * SCALE + ANCHOR)]));
  }

  function comparisons(votes, aspect, name) {
    const out = [];
    for (const v of votes) {
      const a = name(v.left_policy), b = name(v.right_policy), pref = v['pref_' + aspect];
      if (a === b || pref == null) continue;
      if (pref === 'left') out.push([a, b, 1, 'win-a']);
      else if (pref === 'right') out.push([a, b, 0, 'win-b']);
      else if (pref === 'tie') out.push([a, b, 0.5, 'tie']);
      else if (pref === 'neither') out.push([a, b, 0.5, 'both_bad']);
    }
    return out;
  }

  function groups(comps) {
    const parent = {};
    const find = x => { if (!(x in parent)) parent[x] = x; while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const [a, b] of comps) parent[find(a)] = find(b);
    const g = {};
    for (const e of Object.keys(parent)) (g[find(e)] = g[find(e)] || []).push(e);
    return Object.values(g).map(x => x.sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  const pick = (arr, k) => Array.from({ length: k }, () => arr[Math.floor(Math.random() * arr.length)]);
  const quant = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

  function rateGroup(entities, comps, minBattles, nBoot) {
    const st = Object.fromEntries(entities.map(e => [e, { wins: 0, losses: 0, ties: 0, both_bad: 0, battles: 0 }]));
    for (const [a, b, , kind] of comps) {
      st[a].battles++; st[b].battles++;
      if (kind === 'win-a') { st[a].wins++; st[b].losses++; }
      else if (kind === 'win-b') { st[b].wins++; st[a].losses++; }
      else if (kind === 'tie') { st[a].ties++; st[b].ties++; }
      else { st[a].both_bad++; st[b].both_bad++; }
    }
    const el = entities.filter(e => st[e].battles >= minBattles);
    const cmp3 = comps.filter(c => el.includes(c[0]) && el.includes(c[1])).map(c => [c[0], c[1], c[2]]);
    if (!cmp3.length) return [];
    const elo = toElo(mmSolve(el, cmp3));
    const ci = Object.fromEntries(el.map(e => [e, [elo[e], elo[e]]]));
    const rci = Object.fromEntries(el.map(e => [e, [1, el.length]]));
    if (nBoot > 1 && cmp3.length >= 2) {
      const bs = Object.fromEntries(el.map(e => [e, []])), br = Object.fromEntries(el.map(e => [e, []]));
      for (let t = 0; t < nBoot; t++) {
        const be = toElo(mmSolve(el, pick(cmp3, cmp3.length)));
        const order = el.slice().sort((x, y) => (be[y] || 0) - (be[x] || 0));
        const ranks = Object.fromEntries(order.map((e, i) => [e, i + 1]));
        for (const e of el) if (e in be) { bs[e].push(be[e]); br[e].push(ranks[e]); }
      }
      for (const e of el) {
        const s = bs[e].sort((a, b) => a - b), r = br[e].sort((a, b) => a - b);
        if (s.length >= 20) { ci[e] = [quant(s, 0.025), quant(s, 0.975)]; rci[e] = [quant(r, 0.025), quant(r, 0.975)]; }
      }
    }
    const r3 = x => Math.round(x * 1000) / 1000;
    const rows = el.map(e => {
      const s = st[e], decided = s.wins + s.losses, total = s.battles, [lo, hi] = ci[e];
      return { name: e, bt_score: elo[e], ci_lower: Math.round(lo), ci_upper: Math.round(hi), score_ci: Math.round((hi - lo) / 2),
        rank_lo: rci[e][0], rank_hi: rci[e][1], battles: total, wins: s.wins, losses: s.losses, ties: s.ties, both_bad: s.both_bad,
        win_rate: decided ? r3(s.wins / decided) : null, loss_rate: decided ? r3(s.losses / decided) : null,
        tie_rate: total ? r3(s.ties / total) : null, both_bad_rate: total ? r3(s.both_bad / total) : null };
    }).sort((a, b) => b.bt_score - a.bt_score);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  window.computeLeaderboard = function (votes, aspect, name = p => p, minBattles = 1, nBoot = 500) {
    const comps = comparisons(votes, aspect, name), out = [];
    for (const g of groups(comps)) {
      const rows = rateGroup(g, comps.filter(c => g.includes(c[0])), minBattles, nBoot);
      if (rows.length) out.push({ name: g.join(' ↔ '), rows });
    }
    const h = {};
    for (const [a, b, , kind] of comps) {
      const k = a < b ? [a, b] : [b, a], id = k.join('|');
      const d = h[id] = h[id] || { a: k[0], b: k[1], a_wins: 0, b_wins: 0, ties: 0, both_bad: 0, total: 0 };
      d.total++;
      if (kind === 'win-a') (a === d.a ? d.a_wins++ : d.b_wins++);
      else if (kind === 'win-b') (b === d.a ? d.a_wins++ : d.b_wins++);
      else if (kind === 'tie') d.ties++; else d.both_bad++;
    }
    return { groups: out, head_to_head: Object.values(h), n_votes: comps.length };
  };
})();
