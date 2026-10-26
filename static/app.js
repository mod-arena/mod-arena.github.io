// ── Policy battle on pre-computed samples ─────────────────
let _sample       = null;     // payload of the sample on screen ({sample_id, token, post, panels})
let _seen         = [];       // ids shown in this page session (so Skip does not repeat a post)
let _prefs        = { label: null, action: null };   // 'left' | 'right' | 'tie' | 'neither'
let _identities   = null;     // {a:{policy,policy_name}, b:{...}} — only known after the vote
let _voteRevealed = false;

// ── Theme toggle ─────────────────────────────────────────
const LABELS = { light: '🌙 Dark', dark: '☀️ Light' };

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-btn');
  const icon = btn.querySelector('.sidebar-icon');
  const label = btn.querySelector('.sidebar-label');
  if (icon && label) {
    icon.innerHTML = theme === 'light' ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    label.textContent = theme === 'light' ? 'Dark' : 'Light';
  } else {
    btn.textContent = LABELS[theme];
  }
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

applyTheme(localStorage.getItem('theme') || 'light');

// ── Current user / session ───────────────────────────────
let _voteCount = 0;
let _username  = '';

function renderUserInfo() {
  document.getElementById('user-info').innerHTML =
    `<strong>${escHtml(_username)}</strong> · ${_voteCount} vote${_voteCount === 1 ? '' : 's'}`;
}

async function loadMe() {
  try {
    const resp = await fetch('/api/me');
    const data = await resp.json();
    if (!resp.ok || !data.logged_in) { window.location.href = 'login.html'; return; }
    _voteCount = data.vote_count || 0;
    _username  = data.username || '';
    renderUserInfo();
    if (data.is_annotator) document.getElementById('annotate-btn').style.display = '';
  } catch (e) { /* ignore: the next request redirects if the session is gone */ }
}

async function logout() {
  try { sessionStorage.removeItem('arena_entered'); } catch (e) { /* ignore */ }
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  window.location.href = 'login.html';
}

loadMe();

function buildCard(d, platform) {
  const avatar = d.avatar
    ? `<img class="avatar" src="${esc(d.avatar)}" alt="">`
    : `<div class="avatar-placeholder">👤</div>`;

  const COLLAPSE_AT = 400;
  const text = d.text ? '' + (() => {
    const full = escHtml(d.text);
    if (d.text.length <= COLLAPSE_AT) return `<div class="post-text">${full}</div>`;
    const preview = escHtml(d.text.slice(0, COLLAPSE_AT));
    return `<div class="post-text post-text-collapsible">` +
      `<span class="post-text-preview">${preview}…</span>` +
      `<span class="post-text-full" style="display:none">${full}</span>` +
      `<button class="post-text-toggle" onclick="togglePostText(this)">Read more</button>` +
      `</div>`;
  })() + translateBox(d.text) : '';

  // ── Audio transcript (collapsible; opens expanded) ──────────────────────
  const transcriptSection = d.transcript && d.transcript.text
    ? `<div class="transcript-box">
        <button class="media-toggle-btn" onclick="toggleMedia(this)">▼ Audio transcript${d.transcript.language ? ' (' + escHtml(d.transcript.language) + ')' : ''}</button>
        <div class="transcript-body">
          <div class="post-text">${escHtml(d.transcript.text)}</div>
          ${translateBox(d.transcript.text)}
        </div>
      </div>`
    : '';

  // ── Main media (images or video) ────────────────────────────────────────
  let mainMedia = '';
  let mediaCount = 0;

  if (d.images && d.images.length) {
    mediaCount += d.images.length;
    if (d.images.length === 1) {
      const src = d.images[0].url || d.images[0].thumb || '';
      const alt = esc(d.images[0].alt || '');
      mainMedia = `<img src="${esc(src)}" alt="${alt}" loading="lazy"
        onclick="window.open('${esc(src)}','_blank')"
        style="width:auto;max-width:100%;height:auto;max-height:420px;border-radius:10px;display:block;cursor:pointer;margin:0 auto 16px;">`;
    } else {
      const cid = 'car_' + Math.random().toString(36).slice(2, 8);
      const srcs = d.images.map(img => img.url || img.thumb || '');
      const total = srcs.length;
      mainMedia = `<div class="img-carousel" id="${cid}" data-idx="0" data-srcs="${escAttr(JSON.stringify(srcs))}">` +
        `<div class="carousel-slide">` +
        `<img id="${cid}_img" src="${esc(srcs[0])}" alt="" loading="lazy" onclick="window.open(this.src,'_blank')">` +
        `</div>` +
        `<div class="carousel-nav">` +
        `<button type="button" class="carousel-btn" onclick="carouselNav('${cid}',-1);this.blur()">&#8249;</button>` +
        `<span class="carousel-counter" id="${cid}_c">1 / ${total}</span>` +
        `<button type="button" class="carousel-btn" onclick="carouselNav('${cid}',1);this.blur()">&#8250;</button>` +
        `</div></div>`;
    }
  } else if (d.video && (d.video.playlist || d.video.url)) {
    mediaCount += 1;
    const poster = d.video.thumbnail ? `poster="${esc(d.video.thumbnail)}"` : '';
    mainMedia = `<video id="bsky-video" class="bsky-video"
      autoplay loop muted playsinline controls ${poster}></video>`;
  }

  // ── Link card (media part only; link text stays always visible) ─────────
  let linkCardMedia = '';
  let linkCardText  = '';
  if (d.link_card) {
    const lc = d.link_card;
    const label = lc.title || lc.uri;
    if (lc.media_type === 'gif') {
      mediaCount += 1;
      linkCardMedia = `<img src="${esc(lc.uri)}" alt="${escHtml(lc.title)}"
        style="width:100%;border-radius:10px;display:block;">`;
    } else if (lc.media_type === 'video') {
      mediaCount += 1;
      linkCardMedia = `<video autoplay loop muted playsinline controls
        style="width:100%;border-radius:10px;display:block;background:#000;">
        <source src="${esc(lc.uri)}">
      </video>`;
    } else if (lc.thumb) {
      mediaCount += 1;
      linkCardMedia = `<img src="${esc(lc.thumb)}" alt="" loading="lazy"
        style="width:100%;border-radius:10px;display:block;">`;
    }
    linkCardText = `<a href="${esc(lc.uri)}" target="_blank" rel="noopener"
      style="display:inline-block;margin-top:8px;font-size:0.85rem;color:#0085ff;text-decoration:none;word-break:break-all;"
      onmouseover="this.style.textDecoration='underline'"
      onmouseout="this.style.textDecoration='none'">
      ${escHtml(label)}
    </a>`;
  }

  // ── Media toggle wrapper ─────────────────────────────────────────────────
  let mediaSection = '';
  if (mediaCount > 0) {
    const label = mediaCount === 1 ? '1 media item' : `${mediaCount} media items`;
    mediaSection = `
      <button class="media-toggle-btn" onclick="toggleMedia(this)">
        ▶ Show media (${label})
      </button>
      <div class="media-wrapper" style="display:none">
        ${mainMedia}${linkCardMedia}
      </div>`;
  }

  const _platformIcons2 = {'bluesky':'fa-brands fa-bluesky','twitter':'fa-brands fa-x-twitter','x':'fa-brands fa-x-twitter','facebook':'fa-brands fa-facebook','tiktok':'fa-brands fa-tiktok','pinterest':'fa-brands fa-pinterest','threads':'fa-brands fa-threads','instagram':'fa-brands fa-instagram','snapchat':'fa-brands fa-snapchat','linkedin':'fa-brands fa-linkedin','youtube':'fa-brands fa-youtube'};
  const _platformImgIcons2 = {'truthsocial':'static/icons/truthsocial.svg','gettr':'static/icons/gettr.svg'};
  const platformBadge = platform
    ? (_platformImgIcons2[platform]
        ? `<span class="platform-badge"><img src="${_platformImgIcons2[platform]}" alt="" style="width:1em;height:1em;object-fit:contain;vertical-align:-0.1em"></span>`
        : (_platformIcons2[platform]
            ? `<span class="platform-badge"><i class="${_platformIcons2[platform]}"></i></span>`
            : ''))
    : '';

  return `<div class="card">
    <div class="author">
      ${avatar}
      <div class="author-info">
        <span class="display-name">Anonymous user</span>
      </div>
      ${platformBadge}
    </div>
    ${text}${mediaSection}${transcriptSection}${linkCardText}
  </div>`;
}

// ── "Translate to English": shown only when Google detects a language other than English; opens the Google Translate website ─
// Language detection: the browser asks Google's free translate endpoint (it answers with the detected source language) for the
// first 500 characters of the text. If it says English, no link is shown. If the call fails or does not answer within 8 s,
// the link is shown anyway. The link itself just opens translate.google.com in a new tab with the full text; nothing is
// translated in the page. When the detection worked, the link names that language as the source (sl=ar, sl=bn, ...) so the
// website does not run its own detection, which sometimes picks the wrong language (and then returns the text unchanged).
const _langCache = new Map();        // text -> Promise<{lang, english}>

function _googleUrl(t, sl) {
  return 'https://translate.google.com/?sl=' + encodeURIComponent(sl || 'auto') + '&tl=en&op=translate&text=' + encodeURIComponent(String(t).slice(0, 5000));
}

function detectLanguage(text) {
  if (!_langCache.has(text)) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' + encodeURIComponent(text.slice(0, 500));
    _langCache.set(text, fetch(url, { signal: AbortSignal.timeout(8000) })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => ({ lang: d[2] || null, english: (d[0] || []).map(s => (s && s[0]) || '').join('') }))
      .catch(e => { _langCache.delete(text); throw e; }));
  }
  return _langCache.get(text);
}

// markup for one text; hidden until initTranslations() has decided it is not English
function translateBox(t) {
  return `<div class="tr-box" data-text="${escAttr(t)}">
    <a class="view-link view-link-accent translate-link" target="_blank" rel="noopener noreferrer" href="${esc(_googleUrl(t))}"><i class="fa-solid fa-language"></i> Translate</a>
  </div>`;
}

function initTranslations(root) { /* interface adj: nothing to decide, the link is always shown */ }

function togglePostText(btn) {
  const container = btn.closest('.post-text-collapsible');
  const preview = container.querySelector('.post-text-preview');
  const full    = container.querySelector('.post-text-full');
  const expanded = full.style.display !== 'none';
  preview.style.display = expanded ? '' : 'none';
  full.style.display    = expanded ? 'none' : '';
  btn.textContent = expanded ? 'Read more' : 'Read less';
}

function toggleMedia(btn) {
  const wrapper = btn.nextElementSibling;
  const hidden = wrapper.style.display === 'none';
  wrapper.style.display = hidden ? 'block' : 'none';
  const label = btn.textContent.trim().replace(/^[▶▼] /, '');
  btn.textContent = (hidden ? '▼ ' : '▶ ') + label;
}

function carouselNav(id, dir) {
  const el = document.getElementById(id);
  if (!el) return;
  const srcs = JSON.parse(el.dataset.srcs);
  const total = srcs.length;
  const idx = (+el.dataset.idx + dir + total) % total;
  el.dataset.idx = idx;
  document.getElementById(id + '_img').src = srcs[idx];
  document.getElementById(id + '_c').textContent = (idx + 1) + ' / ' + total;
}

function initVideo(video) {
  if (!video) return;
  const el = document.getElementById('bsky-video');
  if (!el) return;
  if (video.url) {
    el.src = video.url;
  } else if (video.playlist) {
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = video.playlist;
    } else if (window.Hls && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(video.playlist);
      hls.attachMedia(el);
    }
  }
}

function esc(s)     { return (typeof s === 'string' ? s : String(s ?? '')).replace(/"/g, '&quot;'); }

const _POLICY_ICONS = {
  bluesky:   'fa-brands fa-bluesky',
  meta:      'fa-brands fa-meta',
  pinterest: 'fa-brands fa-pinterest',
  tiktok:    'fa-brands fa-tiktok',
  x:         'fa-brands fa-x-twitter',
  linkedin:  'fa-brands fa-linkedin',
  snap:      'fa-brands fa-snapchat',
  youtube:   'fa-brands fa-youtube',
  truthsocial: 'fa-solid fa-t',
};

const _POLICY_IMAGE_ICONS = {
  truthsocial: 'static/icons/truthsocial.svg',
  gettr:        'static/icons/gettr.svg',
};

function _policyIcon(key) {
  if (_POLICY_IMAGE_ICONS[key]) {
    return `
      <img
        src="${_POLICY_IMAGE_ICONS[key]}"
        alt=""
        style="
          width:1.1em;
          height:1.1em;
          object-fit:contain;
          vertical-align:-0.15em;
        "
      >
    `;
  }

  const cls = _POLICY_ICONS[key];
  return cls
    ? `<i class="${cls}" style="width:1.1em;text-align:center"></i> `
    : '';
}

//function _policyIcon(key) {
//  const cls = _POLICY_ICONS[key];
//  return cls ? `<i class="${cls}" style="width:1.1em;text-align:center"></i> ` : '';
//}

const _MODEL_ICON_MAP = [
  { match: /gemma/i,             src: 'static/icons/gemma.png'   },
  { match: /qwen/i,              src: 'static/icons/qwen.png'    },
  { match: /mistral|magistral/i, src: 'static/icons/mistral.png' },
  { match: /glm/i,               src: 'static/icons/glm.png'     },
];
function _modelIcon(key) {
  const e = _MODEL_ICON_MAP.find(r => r.match.test(key));
  if (!e) return '';
  return `<img src="${e.src}" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:middle;display:inline-block"> `;
}
function escHtml(s) { return (typeof s === 'string' ? s : JSON.stringify(s) ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return (typeof s === 'string' ? s : String(s ?? ''))
  .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function openReasoningModal(btn) {
  openModal('Full reasoning', btn.dataset.thinking);
}

function openPolicyQuotesModal(btn) {
  const quotes = JSON.parse(btn.dataset.quotes);
  const body = document.getElementById('modal-body');
  document.getElementById('modal-title').textContent = 'Policy quotes';
  body.style.whiteSpace = '';
  body.innerHTML = quotes.map(q =>
    `<blockquote class="policy-quote">${escHtml(q)}</blockquote>`
  ).join('');
  document.getElementById('modal-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

// ── Modal ─────────────────────────────────────────────────
function openModal(title, text, asMarkdown = false) {
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  if (asMarkdown && window.marked) {
    body.innerHTML = marked.parse(text);
    body.style.whiteSpace = '';
  } else {
    body.textContent = text;
    body.style.whiteSpace = 'pre-wrap';
  }
  document.getElementById('modal-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeModal(event) {
  if (event && event.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

async function viewHelp() {
  try {
    const resp = await fetch('help.json');
    if (!resp.ok) return;
    const data = await resp.json();
    openModal('User Guide', data.text, true);
  } catch (e) { /* ignore */ }
}

// ── Comparison grid ───────────────────────────────────────
// text colour (black / white) that reads on a given background colour
function _onColor(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.38 ? '#111' : '#fff';
}

function _dsaPill(cls, item) {
  const title = item.title && item.title !== item.name ? ` title="${escAttr(item.title)}"` : '';
  return `<span class="${cls}" style="background:${item.color};color:${_onColor(item.color)}"${title}>${escHtml(item.name)}</span>`;
}

function renderArena(panels) {
  ['a', 'b'].forEach(p => {
    const d = panels[p];
    // label and action in the uniform DSA vocabulary, in the DSA colours
    document.getElementById(`ag-label-${p}`).innerHTML =
      `<div class="ag-labels">${(d.labels || []).map(l => _dsaPill('mod-badge dsa', l)).join('')}</div>` +
      (d.confidence_text ? `<div class="ag-sub">${escHtml(d.confidence_text)}</div>` : '');

    document.getElementById(`ag-action-${p}`).innerHTML = (d.actions && d.actions.length)
      ? `<div class="ag-chips">${d.actions.map(a => _dsaPill('mod-type-chip dsa-action', a)).join('')}</div>`
      : `<div class="ag-chips"><span class="mod-type-chip none">No action</span></div>`;
  });
}

// The quotes and explanations are only sent once the vote is cast.
function renderReveal(details) {
  ['a', 'b'].forEach(p => {
    const d = details[p];
    const q = d.policy_quotes || [];
    document.getElementById(`ag-quotes-${p}`).innerHTML = q.length
      ? q.map(x => `<blockquote class="ag-quote">${escHtml(x)}</blockquote>`).join('')
      : `<div class="ag-nochoice">No policy quotes cited.</div>`;
    document.getElementById(`ag-explain-${p}`).innerHTML = d.explanation ? escHtml(d.explanation) : '';
  });
  document.getElementById('arena-reveal').style.display = 'block';
}

// ── Sample loading ────────────────────────────────────────
async function loadSample() {
  const out = document.getElementById('result');
  _sample = null;
  clearVotingUI();
  document.getElementById('arena-grid').style.display = 'none';
  document.getElementById('arena-hint').style.display = 'none';
  document.getElementById('arena-reveal').style.display = 'none';
  document.getElementById('reset-btn').style.display = 'none';
  const nextBar = document.getElementById('next-bar');
  if (nextBar) nextBar.style.display = 'none';
  out.innerHTML = '<div class="spinner"></div>';
  try {
    const resp = await fetch('/api/sample?seen=' + encodeURIComponent(_seen.join(',')));
    if (resp.status === 401) { window.location.href = 'login.html'; return; }
    const data = await resp.json();
    if (!resp.ok) {
      out.innerHTML = `<div class="error">Could not load a post: ${escHtml(data.detail || 'Unknown error')}</div>`;
      return;
    }
    if (data.done) {
      out.innerHTML = `<div class="card"><div class="post-text">You have voted on all ${data.total} posts. Thank you for taking part!</div></div>`;
      return;
    }
    _sample = data;
    _seen.push(data.sample_id);
    out.innerHTML = buildCard(data.post, data.post.platform);
    initVideo(data.post.video);
    initTranslations(out);
    renderArena(data.panels);
    applyRowRules(data.rules);                              // interface adj
    document.getElementById('arena-grid').style.display = '';
    document.getElementById('arena-hint').style.display = '';
    document.getElementById('vote-action-row').style.display = 'block';
  } catch (e) {
    out.innerHTML = `<div class="error">Network error while loading a post: ${escHtml(e.message)}</div>`;
  }
}

// ── Voting flow ───────────────────────────────────────────
const _PREF_KEYS = ['label', 'action'];
const _PREF_VALS = ['left', 'tie', 'neither', 'right'];

let _rules = {};     // interface adj: {same_label, same_action, action_na} of the post on screen
    function activeKeys() { return _PREF_KEYS.filter(k => !(k === 'action' && _rules.action_na)); }
    function allAnswered() {
      return activeKeys().every(k => _prefs[k]);
    }
    function applyRowRules(rules) {      // interface adj
      _rules = rules || {};
      [['label', _rules.same_label], ['action', _rules.same_action && !_rules.action_na]].forEach(([k, same]) => {
        ['left', 'right'].forEach(v => { document.getElementById(`pref-${k}-${v}`).style.display = same ? 'none' : ''; });
      });
      if (_rules.action_na) {
        ['a', 'b'].forEach(p => { document.getElementById(`ag-action-${p}`).innerHTML = '<div class="ag-nochoice">—</div>'; });
        const seg = document.getElementById('pref-action-left').parentElement;
        seg.style.display = 'none';
        let note = document.getElementById('action-na-note');
        if (!note) { note = document.createElement('div'); note.id = 'action-na-note'; note.className = 'ag-sub'; seg.parentElement.appendChild(note); }
        note.textContent = 'Not compared here: one of the two policies is Bluesky, which is decentralised: each user chooses which actions to apply, so it has no fixed action.';
        note.style.display = '';
      }
    }
    function resetRowRules() {           // interface adj
      _rules = {};
      ['label', 'action'].forEach(k => ['left', 'right'].forEach(v => { document.getElementById(`pref-${k}-${v}`).style.display = ''; }));
      document.getElementById('pref-action-left').parentElement.style.display = '';
      const note = document.getElementById('action-na-note');
      if (note) note.style.display = 'none';
    }

function setPreference(key, val) {
  _prefs[key] = val;
  highlightPreferences();
  document.getElementById('vote-submit-btn').disabled = !allAnswered();
  updateVoteProgress();
}

function updateVoteProgress() {
  const keys = activeKeys(), n = keys.filter(k => _prefs[k]).length;      // interface adj
  document.getElementById('vote-progress').textContent =
    n === keys.length ? (keys.length === 1 ? 'The row is marked — you can submit.' : 'Both rows marked — you can submit.') : `Mark ${keys.length === 1 ? 'the row' : 'both rows'} to submit (${n} of ${keys.length}).`;
}

function highlightPreferences() {
  _PREF_KEYS.forEach(k => _PREF_VALS.forEach(v =>
    document.getElementById(`pref-${k}-${v}`).classList.toggle('active', _prefs[k] === v)));
}

async function submitVote() {
  if (!allAnswered() || !_sample) return;
  const btn = document.getElementById('vote-submit-btn');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: _sample.token,
        pref_label: _prefs.label, pref_action: _rules.action_na ? 'na' : _prefs.action,
      }),
    });
    if (resp.status === 401) { window.location.href = 'login.html'; return; }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail = Array.isArray(data.detail)
        ? data.detail.map(e => e.msg || JSON.stringify(e)).join('; ')
        : (data.detail || 'Could not record vote.');
      alert(detail);
      btn.disabled = false;
      return;
    }
    if (data.vote_count != null) {
      _voteCount = data.vote_count;
      renderUserInfo();
    }
    _identities = data.identities;
    revealIdentities();
    renderReveal(data.details);
  } catch (e) {
    alert('Network error: ' + e.message);
    btn.disabled = false;
  }
}

function revealIdentities() {
  _voteRevealed = true;
  ['a', 'b'].forEach(p => { document.getElementById(`cmp-result-view-policy-${p}`).style.display = 'inline-block'; });   // interface adj
  ['a', 'b'].forEach(panel => {
    const idn = _identities[panel];
    const el = document.getElementById(`cmp-identity-${panel}`);
    el.innerHTML = `${_policyIcon(idn.policy)}<strong>${escHtml(idn.policy_name)}</strong> policy` + (idn.role === 'flagged' ? ' · flagged this post' : ' · judged it safe');
    el.style.display = 'block';
  });
  // Lock the inputs and swap the action row for the next-post button.
  _PREF_KEYS.forEach(k => _PREF_VALS.forEach(v => { document.getElementById(`pref-${k}-${v}`).disabled = true; }));
  document.getElementById('vote-action-row').style.display = 'none';
  document.getElementById('arena-hint').style.display = 'none';
  document.getElementById('reset-btn').style.display = 'inline-block';
  const bar = document.getElementById('next-bar');          // also at the top right, sticky, so it is never out of sight
  if (bar) bar.style.display = 'flex';
}

function skipVote() {
  loadSample();
}

function clearVotingUI() {
  resetRowRules();                                      // interface adj
  const reveal = document.getElementById('arena-reveal');     // absent on the annotation page
  if (reveal) reveal.style.display = 'none';
  _prefs = { label: null, action: null };
  _identities = null;
  _voteRevealed = false;
  document.getElementById('vote-action-row').style.display = 'none';
  document.getElementById('vote-prior-warning').style.display = 'none';
  document.getElementById('vote-submit-btn').disabled = true;
  updateVoteProgress();
  ['a', 'b'].forEach(panel => {
    document.getElementById(`cmp-identity-${panel}`).style.display = 'none';
    document.getElementById(`cmp-identity-${panel}`).innerHTML = '';
    document.getElementById(`cmp-result-view-policy-${panel}`).style.display = 'none';
  });
  _PREF_KEYS.forEach(k => _PREF_VALS.forEach(v => {
    const el = document.getElementById(`pref-${k}-${v}`);
    el.disabled = false;
    el.classList.remove('active');
  }));
}

async function viewResultPolicy(panel) {
  if (!_sample) return;
  // The policy name stays blind until the vote has been submitted.
  const title = _voteRevealed ? `${_identities[panel].policy_name} Policy` : (panel === 'a' ? 'Policy A' : 'Policy B');
  try {
    const resp = await fetch('/api/policy?token=' + encodeURIComponent(_sample.token) + '&panel=' + panel);
    if (!resp.ok) return;
    const data = await resp.json();
    openModal(title, data.text, true);
  } catch (e) { /* ignore */ }
}

function resetSite() {
  loadSample();
}

if (window.ARENA_MODE !== 'annotate') loadSample();
