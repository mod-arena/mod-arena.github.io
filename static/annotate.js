// ── Annotation view (annotator sessions only) ──────────────────────────────
// Loaded after app.js on /annotate: reuses its post card, comparison grid, preference controls and helpers, and
// replaces the arena flow (random post -> vote -> reveal) with a fixed per-annotator order, a progress bar and no
// reveal at all.

let _annState = null;     // {total, done_count, done: [bool], next}
let _annIndex = 0;        // position in this annotator's order

function annRenderProgress() {
  const s = _annState;
  if (!s) return;
  document.getElementById('ann-stats').innerHTML =
    `<strong>${s.done_count}</strong> / ${s.total} annotated · ${s.total - s.done_count} left`;
  document.getElementById('ann-pos').textContent = `post ${_annIndex + 1} of ${s.total}`;
  document.getElementById('ann-strip').innerHTML = s.done.map((d, i) =>
    `<i class="${i === _annIndex ? 'cur' : (d ? 'done' : '')}"></i>`).join('');
}

// one thin strip (a cell per post); hover shows which post, click jumps to it
function annStripIndex(ev) {
  const r = document.getElementById('ann-strip').getBoundingClientRect();
  const n = _annState ? _annState.total : 0;
  return Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - r.left) / r.width * n)));
}
(function annStripEvents() {
  const strip = document.getElementById('ann-strip'), tip = document.getElementById('ann-tip');
  strip.addEventListener('mousemove', ev => {
    if (!_annState) return;
    const i = annStripIndex(ev), r = strip.getBoundingClientRect();
    tip.textContent = `Post ${i + 1}${_annState.done[i] ? ' — annotated' : ' — not yet'}`;
    tip.style.left = Math.max(40, Math.min(r.width - 40, ev.clientX - r.left)) + 'px';
    tip.style.display = 'block';
  });
  strip.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  strip.addEventListener('click', ev => { if (_annState) loadItem(annStripIndex(ev)); });
})();

function annNextPost() {
  if (_annState && _annIndex < _annState.total - 1) loadItem(_annIndex + 1);
}

async function annLoadState() {
  const resp = await fetch('/api/annotate/state');
  if (resp.status === 401) { window.location.href = 'login.html'; return null; }
  if (resp.status === 403) { window.location.href = 'index.html'; return null; }
  _annState = await resp.json();
  return _annState;
}

function annShowDone() {
  _sample = null;
  clearVotingUI();
  document.getElementById('arena-grid').style.display = 'none';
  document.getElementById('arena-hint').style.display = 'none';
  document.getElementById('result').innerHTML =
    `<div class="card"><div class="post-text">All ${_annState.total} posts are annotated — thank you!
      You can still open any post from the strip above to review or change your answer.</div></div>`;
  annRenderProgress();
}

async function loadItem(i) {
  const out = document.getElementById('result');
  _annIndex = i;
  _sample = null;
  clearVotingUI();
  annRenderProgress();
  document.getElementById('arena-grid').style.display = 'none';
  document.getElementById('arena-hint').style.display = 'none';
  out.innerHTML = '<div class="spinner"></div>';
  try {
    const resp = await fetch('/api/annotate/item?index=' + i);
    if (resp.status === 401) { window.location.href = 'login.html'; return; }
    if (resp.status === 403) { window.location.href = 'index.html'; return; }
    const data = await resp.json();
    if (!resp.ok) {
      out.innerHTML = `<div class="error">Could not load the post: ${escHtml(data.detail || 'Unknown error')}</div>`;
      return;
    }
    _sample = data;
    out.innerHTML = buildCard(data.post, data.post.platform);
    initVideo(data.post.video);
    renderArena(data.panels);
    document.getElementById('arena-grid').style.display = '';
    document.getElementById('arena-hint').style.display = '';
    document.getElementById('vote-action-row').style.display = 'block';
    ['a', 'b'].forEach(p => document.getElementById(`cmp-result-view-policy-${p}`).style.display = 'inline-block');
    document.getElementById('ann-prev-btn').disabled = i === 0;
    if (data.prior) {
      setPreference('label', data.prior.pref_label);
      setPreference('action', data.prior.pref_action);
      document.getElementById('vote-prior-warning').style.display = 'block';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    out.innerHTML = `<div class="error">Network error while loading the post: ${escHtml(e.message)}</div>`;
  }
}

// next position after i that is not annotated yet (wrapping around), or null when everything is done
function annNextOpen(i) {
  const n = _annState.total;
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n;
    if (!_annState.done[j]) return j;
  }
  return null;
}

// Overrides app.js: store the annotation (nothing is revealed) and move on.
async function submitVote() {
  if (!allAnswered() || !_sample) return;
  const btn = document.getElementById('vote-submit-btn');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/annotate/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: _sample.token, pref_label: _prefs.label, pref_action: _prefs.action }),
    });
    if (resp.status === 401) { window.location.href = 'login.html'; return; }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { alert(data.detail || 'Could not save the annotation.'); btn.disabled = false; return; }
    _annState = { total: data.total, done_count: data.done_count, done: data.done, next: data.next };
    loadMe();                                  // refresh the vote count in the sidebar
    const nxt = annNextOpen(_annIndex);
    if (nxt === null) annShowDone(); else loadItem(nxt);
  } catch (e) {
    alert('Network error: ' + e.message);
    btn.disabled = false;
  }
}

// Overrides app.js: leave this post unanswered for now.
function skipVote() {
  const nxt = annNextOpen(_annIndex);
  if (nxt === null || nxt === _annIndex) loadItem((_annIndex + 1) % _annState.total);
  else loadItem(nxt);
}

function annPrev() {
  if (_annIndex > 0) loadItem(_annIndex - 1);
}

(async function annStart() {
  const s = await annLoadState();
  if (!s) return;
  if (s.next === null) { _annIndex = 0; annShowDone(); } else loadItem(s.next);
})();
