// Replaces the FastAPI backend: intercepts the app's /api/* calls and serves them from static JSON + localStorage.
(function () {
  const LS = window.localStorage;
  const get = (k, d) => { try { return JSON.parse(LS.getItem(k)) ?? d; } catch (e) { return d; } };
  const set = (k, v) => LS.setItem(k, JSON.stringify(v));
  const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
  const cache = {};
  const load = f => cache[f] || (cache[f] = fetch('data/' + f, { cache: 'no-cache' }).then(r => r.json()));
  const user = () => get('arena_user', null);
  const votes = () => get('arena_votes:' + (user() || '').toLowerCase(), {});
  const nowTokens = {};   // token -> {id, flagLeft}

  window.downloadVotes = function () {
    const rows = Object.values(votes());
    const blob = new Blob([JSON.stringify({ reviewer: user(), votes: rows }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arena_votes_' + (user() || 'reviewer').replace(/[^\w-]+/g, '_') + '.json';
    a.click();
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts = {}) {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return realFetch(url, opts);
    const path = url.split('?')[0], q = new URLSearchParams(url.split('?')[1] || '');

    if (path === '/api/enter') {
      const name = JSON.parse(opts.body).name.replace(/\s+/g, ' ').trim();
      if (!name) return reply({ detail: 'Please pick a name.' }, 400);
      set('arena_user', name);
      return reply({ ok: true });
    }
    if (path === '/api/logout') { LS.removeItem('arena_user'); return reply({ ok: true }); }
    if (path === '/api/me') {
      if (!user()) return reply({ logged_in: false });
            return reply({ logged_in: true, username: user(), vote_count: Object.keys(votes()).length });
    }

    if (!user()) return reply({ detail: 'Please pick a name first.' }, 401);

    if (path === '/api/sample') {
      const all = await load('samples.json'), done = votes();
      const seen = new Set((q.get('seen') || '').split(',').filter(Boolean));
      let pool = all.filter(s => !done[s.id] && !seen.has(s.id));
      if (!pool.length) pool = all.filter(s => !done[s.id]);
      if (!pool.length) return reply({ done: true, total: all.length, voted: Object.keys(done).length });
      const s = pool[Math.floor(Math.random() * pool.length)];
      const flagLeft = Math.random() < 0.5;
      const token = s.id + '.' + (flagLeft ? 1 : 0);
      nowTokens[token] = { id: s.id, flagLeft };
      return reply({ done: false, sample_id: s.id, token, post: s.post,
        panels: { a: flagLeft ? s.flag : s.safe, b: flagLeft ? s.safe : s.flag },
        total: all.length, voted: Object.keys(done).length });
    }
    if (path === '/api/vote') {
      const b = JSON.parse(opts.body), [id, bit] = b.token.split('.'), flagLeft = bit === '1';
      const key = (await load('key.json'))[id];
      if (!key) return reply({ detail: 'Invalid token.' }, 400);
      const left = flagLeft ? key.flag : key.safe, right = flagLeft ? key.safe : key.flag;
      const row = { reviewer: user(), sample_id: id, left_policy: left.policy, right_policy: right.policy,
        pref_label: b.pref_label, pref_action: b.pref_action, pref_quotes: b.pref_quotes, created_at: new Date().toISOString() };
      const v = votes(); v[id] = row; set('arena_votes:' + user().toLowerCase(), v);
      if (window.ARENA_SUBMIT_URL) {
        realFetch(window.ARENA_SUBMIT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(row) }).catch(() => {});
      }
      return reply({ ok: true, vote_count: Object.keys(v).length, identities: { a: left, b: right } });
    }
    if (path === '/api/policy') {
      const [id, bit] = q.get('token').split('.'), flagLeft = bit === '1';
      const key = (await load('key.json'))[id];
      const side = (q.get('panel') === 'a') === flagLeft ? 'flag' : 'safe';
      return reply({ text: (await load('policies.json'))[key[side].policy] });
    }
    return reply({ detail: 'Not found' }, 404);
  };
})();
