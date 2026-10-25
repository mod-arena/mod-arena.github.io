// Replaces the FastAPI backend: intercepts the app's /api/* calls and serves them from static JSON, the browser's
// storage and (optionally) Firestore.
//
// Firestore layout (see FIREBASE.md):
//   votes/{name__sample}  private, write-only: the full vote with the (made-up) name
//   agg/{all|video|image|text}  public counters, one per (aspect, policy pair, outcome): "label__bluesky__x__a" = 17
//   agg/samples            public counters, "s__<sample id>" = votes so far (to show less-voted posts more often)
// The leaderboard reads only these few small docs (one plain REST GET each, no SDK), so it is fast however many votes exist.
(function () {
  const LS = window.localStorage, SS = window.sessionStorage;
  const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch (e) { return d; } };
  const lget = (k, d) => parse(LS.getItem(k), d);
  const lset = (k, v) => { try { LS.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
  const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
  const cache = {};
  const load = f => cache[f] || (cache[f] = fetch('data/' + f).then(r => (r.ok ? r.json() : null)).catch(() => null));
  const CFG = () => window.FIREBASE_CONFIG;
  const ASPECTS = ['label', 'action'];
  const swap = { left: 'right', right: 'left' };

  // ── session (ends with the tab, like the original session cookie) ──
  const user = () => SS.getItem('arena_user');
  const votesKey = () => 'arena_votes3:' + user().toLowerCase();
  const votes = () => lget(votesKey(), {});                       // {sample_id: row}

  // ── count cells: "label__<a>__<b>__<k>" with a < b policy ids, k = a|b|tie|neither ──
  function cellKeys(row) {
    const [a, b] = row.left_policy < row.right_policy ? [row.left_policy, row.right_policy] : [row.right_policy, row.left_policy];
    const leftIsA = row.left_policy === a, out = {};
    for (const asp of ASPECTS) {
      const p = row['pref_' + asp];
      const k = p === 'tie' ? 'tie' : p === 'neither' ? 'neither' : (p === 'left') === leftIsA ? 'a' : 'b';
      out[`${asp}__${a}__${b}__${k}`] = 1;
    }
    return out;
  }
  const addTo = (m, o, s) => { for (const k in o) m[k] = (m[k] || 0) + s * o[k]; return m; };

  // ── Firestore: reads by REST (instant, no SDK), writes by the SDK loaded in the background ──
  const restDoc = name => `https://firestore.googleapis.com/v1/projects/${CFG().projectId}/databases/(default)/documents/agg/${name}?key=${CFG().apiKey}`;
  const aggMem = {};
  async function refreshAgg(name) {
    try {
      const r = await fetch(restDoc(name));
      const j = r.status === 404 ? { fields: {} } : await r.json();
      if (!r.ok && r.status !== 404) return aggMem[name] || null;
      const m = {};
      for (const [k, v] of Object.entries(j.fields || {})) m[k] = Number(v.integerValue ?? v.doubleValue ?? 0);
      aggMem[name] = m; lset('arena_agg:' + name, m);
      return m;
    } catch (e) { return aggMem[name] || null; }
  }
  // stale-while-revalidate: the last copy is returned at once (and refreshed for the next load); only a first visit waits
  async function getAgg(name) {
    if (!CFG()) return null;
    if (!aggMem[name]) { const c = lget('arena_agg:' + name, null); if (c) aggMem[name] = c; }
    if (aggMem[name]) { refreshAgg(name); return aggMem[name]; }
    return refreshAgg(name);
  }

  let fsReady = null;
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  function firestore() {
    if (!CFG()) return Promise.resolve(null);
    if (!fsReady) {
      const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
      fsReady = loadScript(base + 'firebase-app-compat.js').then(() => loadScript(base + 'firebase-firestore-compat.js'))
        .then(() => { firebase.initializeApp(CFG()); return firebase.firestore(); }).catch(() => null);
    }
    return fsReady;
  }
  const safeId = s => s.replace(/[\/\s]+/g, '_');
  async function pushVote(row, old, ctype) {
    const db = await firestore();
    if (!db) return;
    const inc = firebase.firestore.FieldValue.increment;
    const delta = addTo(addTo({}, cellKeys(row), 1), old ? cellKeys(old) : {}, -1);   // a re-vote replaces the old counts
    const fields = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== 0).map(([k, v]) => [k, inc(v)]));
    try {
      const batch = db.batch(), d = fields(delta);
      batch.set(db.collection('votes').doc(safeId(`${row.reviewer}__${row.sample_id}`)), row);
      if (Object.keys(d).length) {
        batch.set(db.collection('agg').doc('all'), d, { merge: true });
        if (ctype) batch.set(db.collection('agg').doc(ctype), d, { merge: true });
      }
      if (!old) batch.set(db.collection('agg').doc('samples'), { ['s__' + row.sample_id]: inc(1) }, { merge: true });
      await batch.commit();
      Object.keys(aggMem).forEach(k => delete aggMem[k]);            // next read fetches the new counts
    } catch (e) { console.warn('vote not saved remotely', e); }
  }
  if (CFG()) firestore();                                            // load the SDK while the page renders (writes only)

  window.downloadVotes = function () {
    const blob = new Blob([JSON.stringify({ reviewer: user(), votes: user() ? Object.values(votes()) : [] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arena_votes_' + (user() || 'reviewer').replace(/[^\w-]+/g, '_') + '.json';
    a.click();
  };

  // ── leaderboard ──
  const lbMemo = {};
  function cellsFromMap(m, names) {                                   // {"label__a__b__k": n} -> {label:[cells], action:[cells]}
    const out = { label: [], action: [] };
    for (const [key, n] of Object.entries(m || {})) {
      const [asp, a, b, k] = key.split('__');
      if (out[asp] && n > 0) out[asp].push({ a: names[a] || a, b: names[b] || b, k, n });
    }
    // ordering inside a pair follows the display names (a < b), so flip cells whose names sorted the other way
    for (const asp of ASPECTS) out[asp] = out[asp].map(c => (c.a <= c.b ? c : { a: c.b, b: c.a, k: c.k === 'a' ? 'b' : c.k === 'b' ? 'a' : c.k, n: c.n }));
    return out;
  }
  async function leaderboard(ctype, personal) {
    const samples = await load('samples.json'), key = await load('key.json');
    const names = {};
    Object.values(key).forEach(k => { for (const s of ['one', 'two']) names[k[s].policy] = k[s].policy_name; });
    const types = Object.fromEntries(samples.map(s => [s.id, s.post.content_type]));
    let m;
    if (personal) {                                                   // own votes, from this browser
      m = {};
      for (const r of Object.values(votes())) if (!ctype || types[r.sample_id] === ctype) addTo(m, cellKeys(r), 1);
    } else {
      // overall = the annotators' votes (data/seed.json, anonymous counts) + the live reviewer votes (Firestore counters)
      const seed = (await load('seed.json')) || {};
      m = addTo(addTo({}, seed[ctype || 'all'] || {}, 1), (await getAgg(ctype || 'all')) || {}, 1);
    }
    m = m || {};
    const sig = (personal ? 'p' : 'o') + (ctype || '') + '|' + Object.keys(m).sort().map(k => k + '=' + m[k]).join(',');
    if (lbMemo[sig]) return lbMemo[sig];
    const stored = lget('arena_lb', null);
    if (stored && stored.sig === sig) return (lbMemo[sig] = stored.res);   // identical counts as last time: no recomputation
    const c = cellsFromMap(m, names), res = {};
    // overall: a policy is ranked once it has 5 battles; "Mine" ranks from the very first vote
    for (const asp of ASPECTS) {
      const few = personal && c[asp].reduce((s, x) => s + x.n, 0) < 30;       // too few votes for intervals: point estimate with a small prior
      res[asp] = window.computeBoard(c[asp], personal ? 1 : 5, few ? 0 : 500, few ? 0.5 : 0);
    }
    res.available_content_types = [...new Set(Object.values(types))].sort();
    lbMemo[sig] = res; lset('arena_lb', { sig, res });
    return res;
  }

  // ── samples / votes ──
  const parseToken = t => { const [id, bit] = t.split('.'); return { id, oneLeft: bit === '1' }; };

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts = {}) {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return realFetch(url, opts);
    const path = url.split('?')[0], q = new URLSearchParams(url.split('?')[1] || '');
    const body = opts.body ? JSON.parse(opts.body) : {};

    if (path === '/api/enter') {
      const name = (body.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!name) return reply({ detail: 'Please pick a name.' }, 400);
      if (name.length > 64) return reply({ detail: 'The name is too long (at most 64 characters).' }, 400);
      SS.setItem('arena_user', name);
      document.cookie = 'arena_has_session=1; path=/; SameSite=Lax';
      return reply({ ok: true, name, is_annotator: false, vote_count: Object.keys(lget('arena_votes3:' + name.toLowerCase(), {})).length });
    }
    if (path === '/api/logout') {
      SS.removeItem('arena_user');
      document.cookie = 'arena_has_session=; Max-Age=0; path=/';
      return reply({ ok: true });
    }
    if (path === '/api/me') {
      if (!user()) return reply({ logged_in: false });
      return reply({ logged_in: true, username: user(), vote_count: Object.keys(votes()).length, is_annotator: false });
    }
    if (!user()) return reply({ detail: 'Please enter a name first.' }, 401);

    if (path === '/api/landing') {
      const l = await realFetch('landing.json').then(r => r.json()).catch(() => null);
      return reply({ text: l ? l.text : '# Welcome to the Moderation Arena' });
    }
    if (path === '/api/sample') {
      const all = await load('samples.json'), done = new Set(Object.keys(votes()));
      const skip = new Set((q.get('seen') || '').split(',').filter(Boolean));
      let pool = all.filter(s => !done.has(s.id) && !skip.has(s.id));
      if (!pool.length) pool = all.filter(s => !done.has(s.id));
      if (!pool.length) return reply({ done: true, total: all.length, voted: done.size });
      const counts = (await getAgg('samples')) || {};
      // fewer-voted samples are shown more often (weight 1 / (1 + votes so far))
      const w = pool.map(s => 1 / (1 + (counts['s__' + s.id] || 0)));
      let x = Math.random() * w.reduce((p, c) => p + c, 0), i = 0;
      while (i < pool.length - 1 && (x -= w[i]) > 0) i++;
      const s = pool[i], oneLeft = Math.random() < 0.5;
      return reply({ done: false, sample_id: s.id, token: s.id + '.' + (oneLeft ? 1 : 0), post: s.post,
        panels: { a: oneLeft ? s.one : s.two, b: oneLeft ? s.two : s.one }, total: all.length, voted: done.size });
    }
    if (path === '/api/vote') {
      const { id, oneLeft } = parseToken(body.token), key = (await load('key.json'))[id];
      if (!key) return reply({ detail: 'Invalid token.' }, 400);
      for (const v of [body.pref_label, body.pref_action]) if (!['left', 'right', 'tie', 'neither'].includes(v)) return reply({ detail: 'Invalid preference.' }, 400);
      const left = oneLeft ? key.one : key.two, right = oneLeft ? key.two : key.one;
      const row = { reviewer: user(), sample_id: id, mode: 'arena', left_policy: left.policy, right_policy: right.policy,
        pref_label: body.pref_label, pref_action: body.pref_action, created_at: new Date().toISOString() };
      const v = votes(), old = v[id] || null; v[id] = row; lset(votesKey(), v);
      const s = (await load('samples.json')).find(x => x.id === id);
      pushVote(row, old, s && s.post.content_type);
      const det = s => ({ policy_quotes: s.policy_quotes, explanation: s.explanation });
      return reply({ ok: true, vote_count: Object.keys(v).length, identities: { a: left, b: right }, details: { a: det(left), b: det(right) } });
    }
    if (path === '/api/policy') {
      const { id, oneLeft } = parseToken(q.get('token')), key = (await load('key.json'))[id];
      const side = (q.get('panel') === 'a') === oneLeft ? 'one' : 'two';
      return reply({ text: (await load('policies.json'))[key[side].policy] });
    }
    if (path === '/api/leaderboard') return reply(await leaderboard(q.get('content_type_filter') || '', q.get('personalized') === 'true'));
    return reply({ detail: 'Not found' }, 404);
  };
})();
