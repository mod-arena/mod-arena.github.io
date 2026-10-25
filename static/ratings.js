// Bradley-Terry leaderboard in the browser (port of ratings.py). Input is a list of count cells, not individual votes:
//   cells = [{a, b, k, n}]  a < b policy names; k = 'a' (a preferred) | 'b' | 'tie' | 'neither'; n = how many votes.
// Because the Firestore aggregate stores exactly these counts, the cost does not grow with the number of votes: the
// bootstrap resamples the cells (a multinomial draw), which is the same as resampling the individual comparisons.
(function () {
  const SCALE = 400 / Math.log(10), ANCHOR = 1000;
  const OUTCOME = { a: 1, b: 0, tie: 0.5, neither: 0.5 };

  // MM iterations on win vector W (n) and symmetric battle-count matrix N (n*n, flat); p0 sums to n.
  function mm(W, N, n, p0, nIter = 500, tol = 1e-9) {
    let p = Float64Array.from(p0), q = new Float64Array(n);
    for (let it = 0; it < nIter; it++) {
      let tot = 0;
      for (let i = 0; i < n; i++) {
        let d = 0;
        for (let j = 0; j < n; j++) { const c = N[i * n + j]; if (c > 0 && j !== i) d += c / (p[i] + p[j]); }
        q[i] = d > 0 ? (W[i] > 0 ? W[i] / d : 1e-8) : p[i];
        tot += q[i];
      }
      let diff = 0;
      for (let i = 0; i < n; i++) { if (tot > 0) q[i] = q[i] / tot * n; diff = Math.max(diff, Math.abs(q[i] - p[i])); }
      [p, q] = [q, p];
      if (diff < tol) break;
    }
    return p;
  }
  function elo(p) {                                   // log-scores, median-anchored at 1000 (as _to_elo)
    const lg = Array.from(p, v => Math.log(Math.max(v, 1e-10)));
    const med = lg.slice().sort((x, y) => x - y)[Math.floor(lg.length / 2)];
    return lg.map(v => Math.round((v - med) * SCALE + ANCHOR));
  }
  function rng(seed) {                                // mulberry32: the same votes always give the same intervals
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  window.computeBoard = function (cells, minBattles = 5, nBoot = 500, prior = 0, poisson = false) {
    cells = cells.filter(c => c.n > 0);
    const stats = {};
    const S = e => (stats[e] = stats[e] || { wins: 0, losses: 0, ties: 0, both_bad: 0, battles: 0 });
    let nVotes = 0;
    for (const { a, b, k, n } of cells) {
      nVotes += n; S(a).battles += n; S(b).battles += n;
      if (k === 'a') { S(a).wins += n; S(b).losses += n; }
      else if (k === 'b') { S(b).wins += n; S(a).losses += n; }
      else if (k === 'tie') { S(a).ties += n; S(b).ties += n; }
      else { S(a).both_bad += n; S(b).both_bad += n; }
    }
    const rated = Object.keys(stats).filter(e => stats[e].battles >= minBattles).sort();
    const pos = Object.fromEntries(rated.map((e, i) => [e, i])), n = rated.length;
    const cmp = cells.filter(c => c.a in pos && c.b in pos);
    // prior > 0 (the "Mine" view with few votes): every compared pair gets a virtual tie of that weight, in the point fit and in
    // every bootstrap fit, which keeps the scores finite when there is too little data to separate two policies.
    const priorCells = prior > 0 ? [...new Set(cmp.map(c => c.a + '\u0000' + c.b))].map(k => { const [a, b] = k.split('\u0000'); return { a, b, k: 'tie', n: prior }; }) : [];
    // poisson: bootstrap by giving every cell a Poisson(count) weight instead of a fixed total, so with a handful of votes a vote
    // can drop out of a resample and the interval is not stuck at exactly zero.
    let score = [], lo = [], hi = [], rlo = [], rhi = [];
    if (cmp.length) {
      const fit = (counts) => {
        const W = new Float64Array(n), N = new Float64Array(n * n);
        const add = (c, m) => {
          const i = pos[c.a], j = pos[c.b], o = OUTCOME[c.k];
          W[i] += o * m; W[j] += (1 - o) * m; N[i * n + j] += m; N[j * n + i] += m;
        };
        cmp.forEach((c, x) => add(c, counts ? counts[x] : c.n));
        priorCells.forEach(c => add(c, c.n));
        return [W, N];
      };
      const [W0, N0] = fit(null), p0 = mm(W0, N0, n, new Float64Array(n).fill(1));
      score = elo(p0); lo = score.slice(); hi = score.slice();
      const byScore = score.map((v, i) => i).sort((x, y) => (score[y] - score[x]) || (x - y)), pr = Array(n);
      byScore.forEach((i, r) => { pr[i] = r + 1; });
      rlo = pr.slice(); rhi = pr.slice();                  // without a bootstrap the rank "spread" is the rank itself
      const total = cmp.reduce((s, c) => s + c.n, 0);
      if (nBoot >= 20 && total >= 1) {
        const rand = rng(0), bs = Array.from({ length: n }, () => []), br = Array.from({ length: n }, () => []);
        const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
        const binom = (m, p) => {                       // Binomial(m, p): exact for small m, normal approximation otherwise
          if (p <= 0 || m <= 0) return 0;
          if (p >= 1) return m;
          if (m < 40) { let c = 0; for (let i = 0; i < m; i++) if (rand() < p) c++; return c; }
          return Math.max(0, Math.min(m, Math.round(m * p + Math.sqrt(m * p * (1 - p)) * gauss())));
        };
        const pois = lam => {                            // Poisson(lam): Knuth for small lam, normal approximation otherwise
          if (lam >= 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss()));
          const L = Math.exp(-lam); let k = 0, q = 1;
          do { k++; q *= rand(); } while (q > L);
          return k - 1;
        };
        for (let t = 0; t < nBoot; t++) {
          // resampling all comparisons with replacement = a multinomial draw over the cells (cost: cells, not votes)
          const counts = new Float64Array(cmp.length);
          if (poisson) {
            cmp.forEach((c, x) => { counts[x] = pois(c.n); });
          } else {
            let left = total, mass = total;
            for (let x = 0; x < cmp.length && left > 0; x++) {
              counts[x] = x === cmp.length - 1 ? left : binom(left, cmp[x].n / mass);
              left -= counts[x]; mass -= cmp[x].n;
            }
          }
          const [W, N] = fit(counts), s = elo(mm(W, N, n, p0));
          const order = s.map((v, i) => i).sort((x, y) => (s[y] - s[x]) || (x - y)), rank = Array(n);
          order.forEach((i, r) => { rank[i] = r + 1; });
          for (let i = 0; i < n; i++) { bs[i].push(s[i]); br[i].push(rank[i]); }
        }
        const li = Math.floor(0.025 * nBoot), hi_ = Math.floor(0.975 * nBoot);
        for (let i = 0; i < n; i++) {
          const a = bs[i].sort((x, y) => x - y), b = br[i].sort((x, y) => x - y);
          lo[i] = a[li]; hi[i] = a[hi_]; rlo[i] = b[li]; rhi[i] = b[hi_];
        }
      }
    }
    const r3 = x => Math.round(x * 1000) / 1000;
    const rows = rated.map((e, i) => {
      const s = stats[e], decided = s.wins + s.losses, total = s.battles;
      return { name: e, battles: total, wins: s.wins, losses: s.losses, ties: s.ties, both_bad: s.both_bad,
        bt_score: cmp.length ? score[i] : null, score_ci: cmp.length ? Math.round((hi[i] - lo[i]) / 2) : null,
        rank: null, rank_lo: cmp.length ? rlo[i] : null, rank_hi: cmp.length ? rhi[i] : null,
        win_rate: decided ? r3(s.wins / decided) : null, loss_rate: decided ? r3(s.losses / decided) : null,
        tie_rate: total ? r3(s.ties / total) : null, both_bad_rate: total ? r3(s.both_bad / total) : null };
    });
    rows.sort((x, y) => ((x.bt_score === null) - (y.bt_score === null)) || ((y.bt_score || 0) - (x.bt_score || 0)) || (x.name < y.name ? -1 : 1));
    rows.forEach((r, i) => { r.rank = i + 1; });

    const h = {};
    for (const { a, b, k, n: m } of cells) {
      const d = h[a + '|' + b] = h[a + '|' + b] || { a, b, a_wins: 0, b_wins: 0, ties: 0, both_bad: 0, total: 0 };
      d.total += m;
      if (k === 'a') d.a_wins += m; else if (k === 'b') d.b_wins += m; else if (k === 'tie') d.ties += m; else d.both_bad += m;
    }
    return { rows, head_to_head: Object.values(h), n_votes: nVotes };
  };
})();
