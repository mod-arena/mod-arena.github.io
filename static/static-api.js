// Replaces the FastAPI backend: intercepts the app's /api/* calls and serves them from static JSON, the browser's
// storage and (optionally) Firestore. See ../../FIREBASE.md.
(function () {
  const LS = window.localStorage, SS = window.sessionStorage;
  const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch (e) { return d; } };
  const lget = (k, d) => parse(LS.getItem(k), d), lset = (k, v) => LS.setItem(k, JSON.stringify(v));
  const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
  const cache = {};
  const load = f => cache[f] || (cache[f] = fetch('data/' + f, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null));
  const POLICY_NAME = { bluesky: 'Bluesky', x: 'X', tiktok: 'TikTok', snap: 'Snap' };

  // ── session (ends with the tab/browser, like the original session cookie) ──
  const user = () => SS.getItem('arena_user');
  const isAnnotator = () => SS.getItem('arena_annot') === '1';
  const votesKey = () => 'arena_votes2:' + user().toLowerCase();
  const votes = () => lget(votesKey(), {});                      // {"arena:<id>" | "annotation:<id>": row}
  const rowsOf = v => Object.values(v);
  const votedIds = (mode) => new Set(rowsOf(votes()).filter(r => !mode || r.mode === mode).map(r => r.sample_id));
  const effective = rows => {                                    // an annotation vote supersedes the arena vote on the same post
    const m = {};
    for (const r of rows) if (!m[r.sample_id] || r.mode === 'annotation') m[r.sample_id] = r;
    return Object.values(m);
  };

  // ── hashing helpers ──
  const enc = new TextEncoder();
  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const sha256hex = async s => hex(await sha256(s));
  async function pbkdf2hex(password, saltHex, iter) {
    const salt = Uint8Array.from(saltHex.match(/../g) || [], h => parseInt(h, 16));
    const k = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
  }
  const nameKey = n => n.toLowerCase();

  // annotators: data/annotators.json holds only hashes (made by make_annotators.py); absent/empty = no annotators
  async function isAnnotatorName(name) {
    const a = await load('annotators.json');
    return !!(a && a.names && a.names.includes(await sha256hex('annot:' + nameKey(name))));
  }
  async function checkAnnotator(name, password) {
    const a = await load('annotators.json');
    return !!(a && await isAnnotatorName(name) && await pbkdf2hex(password, a.salt, a.iter) === a.hash);
  }

  // ── Firestore (optional): private "votes" (with the name) and public anonymous "battles" (for the leaderboard) ──
  let fsReady = null;
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  function firestore() {
    if (!window.FIREBASE_CONFIG) return Promise.resolve(null);
    if (!fsReady) {
      const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
      fsReady = loadScript(base + 'firebase-app-compat.js').then(() => loadScript(base + 'firebase-firestore-compat.js'))
        .then(() => { firebase.initializeApp(window.FIREBASE_CONFIG); return firebase.firestore(); }).catch(() => null);
    }
    return fsReady;
  }
  const safeId = s => s.replace(/[\/\s]+/g, '_');
  async function pushVote(row) {
    const db = await firestore();
    if (!db) return;
    const uid = (await sha256hex('uid:' + nameKey(row.reviewer))).slice(0, 20);
    try {
      await db.collection('votes').doc(safeId(`${row.reviewer}__${row.sample_id}__${row.mode}`)).set(row);
      const { reviewer, created_at, ...pub } = row;
      // one public doc per (person, post): an annotation overwrites the arena vote, as in the original's "effective votes"
      await db.collection('battles').doc(`${uid}__${row.sample_id}`).set({ uid, ...pub });
    } catch (e) { console.warn('vote not saved remotely', e); }
  }
  let battles = null, battlesAt = 0;
  async function globalBattles() {                               // rows of everyone, or null when Firestore is not configured / unreachable
    const db = await firestore();
    if (!db) return null;
    if (battles && Date.now() - battlesAt < 60000) return battles;
    try {
      const snap = await db.collection('battles').get();
      battles = snap.docs.map(d => d.data());
      battlesAt = Date.now();
      return battles;
    } catch (e) { return battles; }
  }

  window.downloadVotes = function () {
    const blob = new Blob([JSON.stringify({ reviewer: user(), votes: user() ? rowsOf(votes()) : [] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arena_votes_' + (user() || 'reviewer').replace(/[^\w-]+/g, '_') + '.json';
    a.click();
  };

  // ── samples ──
  const parseToken = t => { const [id, bit] = t.split('.'); return { id, flagLeft: bit === '1' }; };
  const blindItem = (s, flagLeft) => ({
    sample_id: s.id, token: s.id + '.' + (flagLeft ? 1 : 0), post: s.post,
    panels: { a: flagLeft ? s.flag : s.safe, b: flagLeft ? s.safe : s.flag },
  });
  const swap = { left: 'right', right: 'left' };

  async function storeVote(body, mode) {
    const { id, flagLeft } = parseToken(body.token);
    const key = (await load('key.json'))[id];
    if (!key) return null;
    for (const v of [body.pref_label, body.pref_action]) if (!['left', 'right', 'tie', 'neither'].includes(v)) return null;
    const left = flagLeft ? key.flag : key.safe, right = flagLeft ? key.safe : key.flag;
    const row = { reviewer: user(), sample_id: id, mode, left_policy: left.policy, right_policy: right.policy,
      pref_label: body.pref_label, pref_action: body.pref_action, created_at: new Date().toISOString() };
    const v = votes(); v[`${mode}:${id}`] = row; lset(votesKey(), v);
    pushVote(row);
    const det = s => ({ policy_quotes: s.policy_quotes, explanation: s.explanation });
    return { left, right, details: { a: det(left), b: det(right) } };
  }

  async function annotationOrder() {
    const all = await load('samples.json'), k = nameKey(user());
    const hs = await Promise.all(all.map(async s => [s.id, await sha256hex(`${k}:${s.id}`)]));
    return hs.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)).map(x => x[0]);
  }
  async function annotationState() {
    const order = await annotationOrder(), done = votedIds('annotation');
    const flags = order.map(id => done.has(id)), nxt = flags.findIndex(f => !f);
    return { total: order.length, done_count: flags.filter(Boolean).length, done: flags, next: nxt < 0 ? null : nxt };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts = {}) {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return realFetch(url, opts);
    const path = url.split('?')[0], q = new URLSearchParams(url.split('?')[1] || '');
    const body = opts.body ? JSON.parse(opts.body) : {};

    if (path === '/api/enter') {
      const name = (body.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!name) return reply({ detail: 'Please pick a name.' }, 400);
      if (name.length > 64) return reply({ detail: 'The name is too long (at most 64 characters).' }, 400);
      let annotator = false;
      if (!body.skip_password && await isAnnotatorName(name)) {
        if (body.password == null) return reply({ ok: false, password_prompt: true });
        if (!await checkAnnotator(name, body.password)) return reply({ detail: 'Wrong password.' }, 401);
        annotator = true;
      }
      SS.setItem('arena_user', name); SS.setItem('arena_annot', annotator ? '1' : '0');
      document.cookie = 'arena_has_session=1; path=/; SameSite=Lax';
      const prior = lget('arena_votes2:' + name.toLowerCase(), {});
      return reply({ ok: true, name, is_annotator: annotator, vote_count: effective(rowsOf(prior)).length });
    }
    if (path === '/api/logout') {
      SS.removeItem('arena_user'); SS.removeItem('arena_annot');
      document.cookie = 'arena_has_session=; Max-Age=0; path=/';
      return reply({ ok: true });
    }
    if (path === '/api/me') {
      if (!user()) return reply({ logged_in: false });
      return reply({ logged_in: true, username: user(), vote_count: votedIds().size, is_annotator: isAnnotator() });
    }
    if (!user()) return reply({ detail: 'Please enter your name first.' }, 401);

    if (path === '/api/landing') {
      const l = await realFetch('landing.json').then(r => r.json()).catch(() => null);
      return reply({ text: l ? l.text : '# Welcome to the Moderation Arena' });
    }
    if (path === '/api/sample') {
      const all = await load('samples.json'), done = votedIds();
      const skip = new Set((q.get('seen') || '').split(',').filter(Boolean));
      let pool = all.filter(s => !done.has(s.id) && !skip.has(s.id));
      if (!pool.length) pool = all.filter(s => !done.has(s.id));
      if (!pool.length) return reply({ done: true, total: all.length, voted: done.size });
      const b = await globalBattles(), counts = {};
      (b || []).forEach(r => { counts[r.sample_id] = (counts[r.sample_id] || 0) + 1; });
      // fewer-voted samples are shown more often (weight 1 / (1 + votes so far))
      const w = pool.map(s => 1 / (1 + (counts[s.id] || 0)));
      let x = Math.random() * w.reduce((p, c) => p + c, 0), i = 0;
      while (i < pool.length - 1 && (x -= w[i]) > 0) i++;
      return reply({ done: false, ...blindItem(pool[i], Math.random() < 0.5), total: all.length, voted: done.size });
    }
    if (path === '/api/vote') {
      const r = await storeVote(body, 'arena');
      if (!r) return reply({ detail: 'Invalid vote.' }, 400);
      return reply({ ok: true, vote_count: votedIds().size, identities: { a: r.left, b: r.right }, details: r.details });
    }
    if (path === '/api/policy') {
      const { id, flagLeft } = parseToken(q.get('token')), key = (await load('key.json'))[id];
      const side = (q.get('panel') === 'a') === flagLeft ? 'flag' : 'safe';
      return reply({ text: (await load('policies.json'))[key[side].policy] });
    }

    if (path.startsWith('/api/annotate/')) {
      if (!isAnnotator()) return reply({ detail: 'Annotator access only.' }, 403);
      if (path === '/api/annotate/state') return reply(await annotationState());
      if (path === '/api/annotate/item') {
        const order = await annotationOrder(), index = parseInt(q.get('index'), 10);
        if (!(index >= 0 && index < order.length)) return reply({ detail: 'No such item.' }, 404);
        const id = order[index], s = (await load('samples.json')).find(x => x.id === id), key = (await load('key.json'))[id];
        const flagLeft = (await sha256(`${nameKey(user())}:${id}:side`))[0] % 2 === 0;   // fixed A/B sides per annotator and post
        const item = blindItem(s, flagLeft), prior = votes()['annotation:' + id];
        item.prior = null;
        if (prior) {
          const fix = (prior.left_policy === key.flag.policy) === flagLeft ? v => v : v => swap[v] || v;
          item.prior = { pref_label: fix(prior.pref_label), pref_action: fix(prior.pref_action) };
        }
        return reply({ ...item, index, total: order.length });
      }
      if (path === '/api/annotate/vote') {
        if (!await storeVote(body, 'annotation')) return reply({ detail: 'Invalid vote.' }, 400);
        return reply({ ok: true, ...(await annotationState()) });
      }
    }

    if (path === '/api/leaderboard') {
      const aspect = q.get('aspect') || 'label', ctype = q.get('content_type_filter'), personal = q.get('personalized') === 'true';
      const types = Object.fromEntries((await load('samples.json')).map(s => [s.id, s.post.content_type]));
      const mine = effective(rowsOf(votes()));
      const all = personal ? mine : effective((await globalBattles()) || mine);   // without Firestore: only this browser's votes
      const rows = ctype ? all.filter(r => types[r.sample_id] === ctype) : all;
      const res = window.computeLeaderboard(rows, aspect, p => POLICY_NAME[p] || p, 1, 500);
      res.available_content_types = [...new Set(effective((await globalBattles()) || mine).map(r => types[r.sample_id]).filter(Boolean))].sort();
      return reply(res);
    }
    return reply({ detail: 'Not found' }, 404);
  };
})();
