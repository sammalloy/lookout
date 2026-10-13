// Lookout review app. No build step: plain ES modules served by the Lookout server.

const app = document.getElementById('app');
const whoButton = document.getElementById('who');

const NEEDS_REVIEW = ['new', 'changed'];
const REVIEWABLE = ['new', 'changed', 'accepted', 'denied'];
const STATE_LABEL = {
  new: 'New', changed: 'Changed', accepted: 'Accepted', denied: 'Denied', unchanged: 'Unchanged', error: 'Error',
};

// --- identity -------------------------------------------------------------
// Until Bitbucket sign-in is added, reviewers type the Bitbucket username they use in .lookout.yml.
function storedUser() {
  try { return localStorage.getItem('lookout.user') || ''; } catch { return ''; }
}
function currentUser({ ask = true } = {}) {
  let user = storedUser();
  if (!user && ask) {
    user = (prompt('Your Bitbucket username (used for approvals):') || '').trim();
    if (user) try { localStorage.setItem('lookout.user', user); } catch {}
  }
  renderWho();
  return user;
}
function renderWho() {
  const user = storedUser();
  whoButton.textContent = user ? `Signed in as ${user} (change)` : 'Set your name';
}
whoButton.onclick = () => {
  try { localStorage.removeItem('lookout.user'); } catch {}
  currentUser();
  route();
};

// --- helpers --------------------------------------------------------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function badge(state) {
  return `<span class="badge s-${esc(state)}">${esc(STATE_LABEL[state] || state)}</span>`;
}

// --- routing --------------------------------------------------------------
const view = { filter: 'review', project: 'all', component: null, inspect: {} };

async function route() {
  renderWho();
  const hash = location.hash.replace(/^#/, '') || '/';
  const m = hash.match(/^\/review\/(.+)$/);
  try {
    if (m) await renderReview(decodeURIComponent(m[1]));
    else await renderHome();
  } catch (err) {
    app.innerHTML = `<div class="empty">Couldn't load this page: ${esc(err.message)}</div>`;
  }
}
window.addEventListener('hashchange', () => {
  view.component = null;
  route();
});

// --- home -----------------------------------------------------------------
async function renderHome() {
  const reviews = await api('GET', '/api/reviews');
  if (reviews.length === 0) {
    app.innerHTML = `<div class="empty">No builds yet. Run <code>lookout run</code> in CI or locally to upload the first one.</div>`;
    return;
  }
  app.innerHTML = `
    <h1>Reviews</h1>
    <div class="panel"><table>
      <thead><tr><th>Pull request / branch</th><th>Branch</th><th>Last build</th></tr></thead>
      <tbody>${reviews.map(r => `
        <tr>
          <td><a href="#/review/${encodeURIComponent(r.review_key)}">${r.pr_id ? `PR #${esc(r.pr_id)}` : esc(r.branch)}</a></td>
          <td class="muted">${esc(r.branch)}</td>
          <td class="muted">${esc(r.updated_at)} UTC</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

// --- review page ----------------------------------------------------------
let current = null;

async function renderReview(key, data) {
  current = data || (await api('GET', `/api/reviews/${encodeURIComponent(key)}`));
  const r = current;
  const projects = [...new Set(r.snapshots.map(s => s.project))];
  const reviewable = r.snapshots.filter(s => REVIEWABLE.includes(s.state) || s.state === 'error');
  const pending = r.snapshots.filter(s => NEEDS_REVIEW.includes(s.state));

  const shown = r.snapshots.filter(s => {
    if (view.project !== 'all' && s.project !== view.project) return false;
    if (view.component && s.title !== view.component) return false;
    if (view.filter === 'review') return NEEDS_REVIEW.includes(s.state) || s.state === 'error';
    if (view.filter === 'changes') return REVIEWABLE.includes(s.state) || s.state === 'error';
    return true;
  });

  app.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <div>
        <h1>${r.prId ? `PR #${esc(r.prId)}` : esc(r.branch)}</h1>
        <div class="muted">${esc(r.branch)} into ${esc(r.baseBranch)} at ${esc(r.commit.slice(0, 10))}
          · ${projects.length} project${projects.length === 1 ? '' : 's'}
          ${r.builds.map(b => b.storybookUrl ? ` · <a href="${esc(b.storybookUrl)}" target="_blank">${esc(b.project)} Storybook</a>` : '').join('')}</div>
      </div>
    </div>
    <div class="layout">
      <div>
        ${impactTable(r, projects)}
        <div class="filters">
          <div class="tabs">
            ${[['review', `Needs review (${pending.length})`], ['changes', `All changes (${reviewable.length})`], ['all', `Everything (${r.snapshots.length})`]]
              .map(([k, label]) => `<button data-filter="${k}" class="${view.filter === k ? 'on' : ''}">${label}</button>`).join('')}
          </div>
          <select id="project-filter">
            <option value="all">All projects</option>
            ${projects.map(p => `<option ${view.project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select>
          ${view.component ? `<button id="clear-component">Component: ${esc(view.component)} ✕</button>` : ''}
          <span class="spacer"></span>
          ${shown.some(s => NEEDS_REVIEW.includes(s.state)) ? `<button id="accept-shown" class="primary">Accept all shown</button>` : ''}
        </div>
        ${shown.length ? groups(shown) : `<div class="panel empty">${pending.length ? 'Nothing matches this filter.' : 'Nothing left to review.'}</div>`}
      </div>
      <aside class="side">${sidePanel(r)}</aside>
    </div>`;

  bindReview(key);
}

/** Components × projects: how far a change reaches. */
function impactTable(r, projects) {
  const changed = r.snapshots.filter(s => REVIEWABLE.includes(s.state) || s.state === 'error');
  if (changed.length === 0) return '';
  const titles = [...new Set(changed.map(s => s.title))].sort();
  const present = new Set(r.snapshots.map(s => `${s.project}|${s.title}`));
  const cell = (p, t) => {
    if (!present.has(`${p}|${t}`)) return `<td class="muted">not used</td>`;
    const list = changed.filter(s => s.project === p && s.title === t);
    const stories = new Set(list.map(s => s.storyId)).size;
    if (stories === 0) return `<td class="muted">0</td>`;
    const open = list.some(s => NEEDS_REVIEW.includes(s.state));
    return `<td class="num" data-project="${esc(p)}" data-component="${esc(t)}">
      <span class="${open ? 's-changed' : 's-accepted'}">${stories} stor${stories === 1 ? 'y' : 'ies'}</span></td>`;
  };
  return `<div class="panel">
    <h3 style="margin-bottom:6px">Impact</h3>
    <div class="muted" style="margin-bottom:8px">Changed stories per component, in each project built for this commit.</div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Component</th>${projects.map(p => `<th>${esc(p)}</th>`).join('')}</tr></thead>
      <tbody>${titles.map(t => `<tr><td>${esc(t)}</td>${projects.map(p => cell(p, t)).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

function sidePanel(r) {
  const statuses = r.statuses.map(s => `
    <div class="status"><span class="badge s-${s.state}">${s.state === 'SUCCESSFUL' ? 'Passed' : s.state === 'FAILED' ? 'Failed' : 'Pending'}</span>
    <div><div>${esc(s.name)}</div><div class="muted">${esc(s.description)}</div></div></div>`).join('');

  let approval = '';
  if (r.approval) {
    const a = r.approval;
    const reqs = a.requirements.length
      ? a.requirements.map(q => `
        <div class="req"><span class="dot ${q.satisfiedBy ? 'ok' : ''}"></span>
          <div><div>${q.rule === 'default' ? 'Default reviewers' : esc(q.rule)}</div>
          <div class="muted">${q.satisfiedBy ? `Approved by ${esc(q.satisfiedBy)}` : esc(q.reviewers.join(', ') || 'anyone')}</div></div></div>`).join('')
      : `<div class="muted">No reviewer rules matched these changes.</div>`;
    approval = `
      <h3 style="margin:14px 0 6px">Reviewers</h3>
      ${reqs}
      ${a.changesRequested.length ? `<div class="s-FAILED" style="margin-top:6px">Changes requested by ${esc(a.changesRequested.join(', '))}</div>` : ''}
      ${a.approvals.length ? `<div class="muted" style="margin-top:6px">Approvals: ${esc(a.approvals.join(', '))}</div>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="primary" id="approve">Approve</button>
        <button class="danger" id="request-changes">Request changes</button>
      </div>
      <div class="muted" style="margin-top:8px;font-size:12px">Approvals reset when a new push changes the screenshots.</div>`;
  }
  return `<div class="panel"><h3 style="margin-bottom:6px">Bitbucket checks</h3>${statuses}${approval}</div>`;
}

function groups(snaps) {
  // project → component → story → modes
  const byKey = new Map();
  for (const s of snaps) {
    const k = `${s.project}|${s.storyId}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  let html = '';
  let lastGroup = '';
  for (const [k, modes] of byKey) {
    const s = modes[0];
    const group = `${s.project} / ${s.title}`;
    if (group !== lastGroup) {
      html += `<div class="group-title"><h2 style="margin:0">${esc(s.title)}</h2><span class="muted">${esc(s.project)}</span></div>`;
      lastGroup = group;
    }
    html += modes.map(storyCard).join('');
  }
  return html;
}

function storyCard(s) {
  const id = s.id;
  const mode = view.inspect[id] || (s.hasDiff ? 'side' : 'single');
  const baseImg = s.baseHash ? `/images/${s.baseHash}.png` : null;
  const newImg = s.hash ? `/images/${s.hash}.png` : null;
  let body;
  if (s.state === 'error') {
    body = `<div class="s-error">Capture failed: ${esc(s.error)}</div>`;
  } else if (mode === 'side' && baseImg) {
    body = `<div class="images">
      <div><span class="label">Baseline (${esc(current.baseBranch)})</span><div class="shot"><img src="${baseImg}" loading="lazy"></div></div>
      <div><span class="label">This build</span><div class="shot"><img src="${newImg}" loading="lazy"></div></div></div>`;
  } else if (mode === 'diff' && s.hasDiff) {
    body = `<div class="images single"><div><span class="label">Changed pixels</span><div class="shot"><img src="/diffs/${id}.png" loading="lazy"></div></div></div>`;
  } else if (mode === 'overlay' && baseImg) {
    body = `<div class="shot"><div class="overlay"><img src="${baseImg}"><img class="top" src="${newImg}" style="opacity:.5" id="ov-${id}"></div></div>
      <div class="row" style="margin-top:6px"><span class="muted">Baseline</span><input type="range" min="0" max="100" value="50" data-overlay="${id}"><span class="muted">This build</span></div>`;
  } else {
    body = `<div class="images single"><div><span class="label">${s.state === 'new' ? 'New story' : 'This build'}</span><div class="shot"><img src="${newImg}" loading="lazy"></div></div></div>`;
  }
  const comments = current.comments.filter(c => c.story_id === s.storyId && c.mode === s.mode && c.project === s.project);
  const pct = s.diffRatio ? ` · ${(s.diffRatio * 100).toFixed(2)}% of pixels` : '';
  const actions = REVIEWABLE.includes(s.state)
    ? `${s.state !== 'accepted' ? `<button class="primary" data-act="accept" data-id="${id}">Accept</button>` : ''}
       ${s.state !== 'denied' ? `<button class="danger" data-act="deny" data-id="${id}">Deny</button>` : ''}
       ${['accepted', 'denied'].includes(s.state) ? `<button data-act="reset" data-id="${id}">Undo</button>` : ''}`
    : '';
  const tabs = baseImg && s.hasDiff
    ? `<div class="tabs">${[['side', 'Side by side'], ['diff', 'Diff'], ['overlay', 'Overlay']]
        .map(([k, l]) => `<button data-inspect="${k}" data-id="${id}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>`
    : '';
  return `<div class="card">
    <div class="card-head">
      <h3>${esc(s.name)}</h3><span class="muted">${esc(s.mode)}</span>${badge(s.state)}
      <span class="muted" style="font-size:12px">${s.decidedBy ? `by ${esc(s.decidedBy)}` : ''}${pct}${s.inherited ? ' · reused, not affected by this change' : ''}</span>
      <span class="spacer"></span>${tabs}${actions}
    </div>
    <div class="card-body">${body}
      <div class="comments">
        ${comments.map(c => `<div class="comment"><strong>${esc(c.user)}</strong> <span class="muted">${esc(c.created_at)}</span><div>${esc(c.body)}</div></div>`).join('')}
        <form data-comment="${id}" class="row" style="margin-top:6px">
          <input type="text" name="body" placeholder="Comment on this snapshot" style="flex:1">
          <button>Comment</button>
        </form>
      </div>
    </div>
  </div>`;
}

function bindReview(key) {
  const act = async (fn) => {
    const user = currentUser();
    if (!user) return;
    try {
      const data = await fn(user);
      await renderReview(key, data);
    } catch (err) {
      alert(err.message);
    }
  };
  app.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { view.filter = b.dataset.filter; renderReview(key, current); });
  const pf = app.querySelector('#project-filter');
  if (pf) pf.onchange = () => { view.project = pf.value; renderReview(key, current); };
  const cc = app.querySelector('#clear-component');
  if (cc) cc.onclick = () => { view.component = null; renderReview(key, current); };
  app.querySelectorAll('td.num').forEach(td => td.onclick = () => {
    view.project = td.dataset.project; view.component = td.dataset.component; view.filter = 'changes';
    renderReview(key, current);
  });
  app.querySelectorAll('[data-inspect]').forEach(b => b.onclick = () => { view.inspect[b.dataset.id] = b.dataset.inspect; renderReview(key, current); });
  app.querySelectorAll('[data-overlay]').forEach(input => input.oninput = () => {
    document.getElementById(`ov-${input.dataset.overlay}`).style.opacity = String(input.value / 100);
  });
  app.querySelectorAll('[data-act]').forEach(b => b.onclick = () =>
    act(user => api('POST', `/api/snapshots/${b.dataset.id}/${b.dataset.act}`, { user })));
  const acceptShown = app.querySelector('#accept-shown');
  if (acceptShown) acceptShown.onclick = () => {
    const ids = [...app.querySelectorAll('[data-act="accept"]')].map(b => Number(b.dataset.id));
    act(user => api('POST', '/api/snapshots/batch/accept', { user, ids }));
  };
  const approve = app.querySelector('#approve');
  if (approve) approve.onclick = () => act(user => api('POST', `/api/reviews/${encodeURIComponent(key)}/verdict`, { user, verdict: 'approved' }));
  const reject = app.querySelector('#request-changes');
  if (reject) reject.onclick = () => act(user => api('POST', `/api/reviews/${encodeURIComponent(key)}/verdict`, { user, verdict: 'changes_requested' }));
  app.querySelectorAll('form[data-comment]').forEach(form => form.onsubmit = e => {
    e.preventDefault();
    const body = form.body.value.trim();
    if (!body) return;
    const s = current.snapshots.find(x => String(x.id) === form.dataset.comment);
    act(user => api('POST', `/api/reviews/${encodeURIComponent(key)}/comments`, { user, body, storyId: s.storyId, mode: s.mode, project: s.project }));
  });
}

route();
