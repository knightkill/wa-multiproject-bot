(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'wp:admin';

  const state = {
    token: sessionStorage.getItem(STORAGE_KEY) || '',
    projects: [],
    groups: [],
    allowlist: new Set(),
    activeTab: 'projects',
    readableGroups: new Set(),
    readablePeople: [],
    readableChats: [],
    inboundFilterJid: '',
    inboundFilterFromMe: true,
  };

  async function api(path, opts = {}) {
    const res = await fetch(`/admin/api${path}`, {
      ...opts,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
        Authorization: `Bearer ${state.token}`,
      },
    });
    const contentType = res.headers.get('content-type') || '';
    const json = contentType.includes('json') ? await res.json() : null;
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function publicGet(path) {
    const res = await fetch(path);
    return res.json();
  }

  function el(tag, opts = {}) {
    const node = document.createElement(tag);
    if (opts.text != null) node.textContent = opts.text;
    if (opts.cls) node.className = opts.cls;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    if (opts.on) for (const [evt, fn] of Object.entries(opts.on)) node.addEventListener(evt, fn);
    if (opts.children) for (const child of opts.children) node.appendChild(child);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return d.toLocaleString();
  }

  async function refreshStatus() {
    try {
      const j = await publicGet('/');
      $('status').textContent = j.paired ? 'paired' : 'not paired';
      $('status').setAttribute('data-paired', String(j.paired));
    } catch {
      $('status').textContent = 'unreachable';
    }
  }

  function showLogin() {
    $('login-view').hidden = false;
    $('app-view').hidden = true;
  }

  function showApp() {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    selectTab(state.activeTab);
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('login-token').value.trim();
    state.token = token;
    try {
      await api('/projects');
      sessionStorage.setItem(STORAGE_KEY, token);
      $('login-error').hidden = true;
      $('login-token').value = '';
      showApp();
      await loadAll();
    } catch (err) {
      state.token = '';
      $('login-error').textContent = err.status === 401 ? 'invalid token' : err.message;
      $('login-error').hidden = false;
    }
  });

  $('logout').addEventListener('click', () => {
    sessionStorage.removeItem(STORAGE_KEY);
    state.token = '';
    showLogin();
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.getAttribute('data-tab')));
  });

  function selectTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${name}`);
    });
    if (name === 'messages') loadMessages();
    if (name === 'read') loadReadTab();
  }

  async function loadAll() {
    await Promise.all([loadProjects(), loadGroupsAndAllowlist()]);
  }

  async function loadProjects() {
    try {
      const j = await api('/projects');
      state.projects = j.projects;
      renderProjects();
    } catch (err) {
      if (err.status === 401) showLogin();
    }
  }

  async function loadGroupsAndAllowlist() {
    try {
      const [groupsRes, allowRes] = await Promise.all([
        api('/groups').catch((e) => {
          if (e.status === 503) return { groups: [] };
          throw e;
        }),
        api('/allowlist'),
      ]);
      state.groups = groupsRes.groups;
      state.allowlist = new Set(allowRes.jids);
      renderAllowlist();
    } catch (err) {
      if (err.status === 401) showLogin();
    }
  }

  async function loadMessages() {
    try {
      const j = await api('/messages?limit=100');
      renderMessages(j.messages);
    } catch (err) {
      if (err.status === 401) showLogin();
    }
  }

  function renderProjects() {
    const list = $('projects-list');
    clear(list);
    if (state.projects.length === 0) {
      list.appendChild(el('p', { cls: 'muted', text: 'No projects yet.' }));
      return;
    }
    for (const p of state.projects) {
      const groupCount = p.groupJids.length;
      const meta = el('div', {
        cls: 'item-meta',
        text: `${groupCount} group${groupCount === 1 ? '' : 's'} • created ${fmtTime(
          p.createdAt
        )}`,
      });

      const actions = el('div', { cls: 'item-actions' });
      actions.appendChild(
        el('button', {
          text: 'Edit groups',
          cls: 'ghost',
          on: { click: () => openProjectModal(p) },
        })
      );
      actions.appendChild(
        el('button', {
          text: 'Rotate token',
          cls: 'ghost',
          on: { click: () => rotateToken(p) },
        })
      );
      actions.appendChild(
        el('button', {
          text: 'Delete',
          cls: 'danger',
          on: { click: () => deleteProject(p) },
        })
      );

      const head = el('div', {
        cls: 'item-head',
        children: [el('span', { cls: 'item-name', text: p.name }), actions],
      });

      const item = el('div', { cls: 'item', children: [head, meta] });
      list.appendChild(item);
    }
  }

  function renderAllowlist() {
    const list = $('allowlist-list');
    clear(list);
    if (state.groups.length === 0) {
      list.appendChild(
        el('p', {
          cls: 'muted',
          text: 'No groups available (phone may not be paired yet).',
        })
      );
      return;
    }
    const container = el('div', { cls: 'checklist' });
    for (const g of state.groups) {
      const checkbox = el('input', {
        attrs: { type: 'checkbox', 'data-jid': g.jid },
      });
      if (state.allowlist.has(g.jid)) checkbox.checked = true;
      const label = el('label', {
        children: [checkbox, el('span', { text: `${g.subject || '(no subject)'} — ${g.jid}` })],
      });
      container.appendChild(label);
    }
    list.appendChild(container);
  }

  $('save-allowlist').addEventListener('click', async () => {
    const jids = [];
    document
      .querySelectorAll('#allowlist-list input[type="checkbox"]')
      .forEach((cb) => {
        if (cb.checked) jids.push(cb.getAttribute('data-jid'));
      });
    try {
      await api('/allowlist', { method: 'PUT', body: JSON.stringify({ jids }) });
      state.allowlist = new Set(jids);
    } catch (err) {
      alert(err.message);
    }
  });

  function renderMessages(messages) {
    const list = $('messages-list');
    clear(list);
    if (messages.length === 0) {
      list.appendChild(el('p', { cls: 'muted', text: 'No messages logged yet.' }));
      return;
    }
    for (const m of messages) {
      const headChildren = [el('span', { cls: 'item-name', text: m.title })];
      if (m.media_count > 0) {
        headChildren.push(
          el('span', {
            cls: 'msg msg-media',
            text: `${m.media_count} item${m.media_count === 1 ? '' : 's'}`,
          })
        );
      }
      headChildren.push(
        el('span', {
          cls: `msg msg-status-${m.status}`,
          text: m.status,
        })
      );
      const head = el('div', { cls: 'item-head', children: headChildren });
      const meta = el('div', {
        cls: 'item-meta',
        text: `${m.project_name} → ${m.group_jid} • ${fmtTime(m.created_at)}${
          m.error ? ` • ${m.error}` : ''
        }`,
      });
      list.appendChild(el('div', { cls: 'item', children: [head, meta] }));
    }
  }

  $('refresh-messages').addEventListener('click', loadMessages);

  async function loadReadTab() {
    try {
      // /api/groups already loaded by loadGroupsAndAllowlist when paired;
      // if Read tab opens before that, fetch on demand.
      if (state.groups.length === 0) await loadGroupsAndAllowlist();
      const chatsRes = await api('/readable-chats');
      state.readableChats = chatsRes.chats;
      state.readableGroups = new Set(
        chatsRes.chats.filter((c) => c.kind === 'group').map((c) => c.jid)
      );
      state.readablePeople = chatsRes.chats
        .filter((c) => c.kind === 'person')
        .map((c) => ({ jid: c.jid, label: c.label ?? '' }));
      renderReadableGroups();
      renderReadablePeople();
      renderInboundFilterOptions();
      await loadInbound();
    } catch (err) {
      if (err.status === 401) showLogin();
    }
  }

  function renderReadableGroups() {
    const container = $('readable-groups');
    clear(container);
    if (state.groups.length === 0) {
      container.appendChild(
        el('p', { cls: 'muted', text: 'No groups available (phone may not be paired yet).' })
      );
      return;
    }
    for (const g of state.groups) {
      const cb = el('input', { attrs: { type: 'checkbox', 'data-jid': g.jid } });
      if (state.readableGroups.has(g.jid)) cb.checked = true;
      container.appendChild(
        el('label', {
          children: [cb, el('span', { text: `${g.subject || '(no subject)'} — ${g.jid}` })],
        })
      );
    }
  }

  function renderReadablePeople() {
    const list = $('readable-people');
    clear(list);
    if (state.readablePeople.length === 0) {
      list.appendChild(el('p', { cls: 'muted', text: 'No people added yet.' }));
      return;
    }
    state.readablePeople.forEach((p, idx) => {
      const jidIn = el('input', {
        attrs: {
          type: 'text',
          placeholder: '6191234567@s.whatsapp.net',
          value: p.jid,
          'data-idx': String(idx),
          'data-field': 'jid',
        },
      });
      const labelIn = el('input', {
        attrs: {
          type: 'text',
          placeholder: 'label (optional)',
          value: p.label,
          'data-idx': String(idx),
          'data-field': 'label',
        },
      });
      const remove = el('button', {
        text: 'Remove',
        cls: 'ghost',
        on: {
          click: () => {
            state.readablePeople.splice(idx, 1);
            renderReadablePeople();
          },
        },
      });
      const row = el('div', { cls: 'item person-row', children: [jidIn, labelIn, remove] });
      list.appendChild(row);
    });
  }

  // Sync DOM inputs back into state on every keystroke so re-renders
  // don't lose typing-in-progress.
  $('readable-people').addEventListener('input', (e) => {
    const idx = e.target.getAttribute('data-idx');
    const field = e.target.getAttribute('data-field');
    if (idx == null || !field) return;
    state.readablePeople[Number(idx)][field] = e.target.value;
  });

  $('add-person').addEventListener('click', () => {
    state.readablePeople.push({ jid: '', label: '' });
    renderReadablePeople();
  });

  $('save-readable').addEventListener('click', async () => {
    const chats = [];
    document.querySelectorAll('#readable-groups input[type="checkbox"]').forEach((cb) => {
      if (cb.checked) chats.push({ jid: cb.getAttribute('data-jid'), kind: 'group' });
    });
    for (const p of state.readablePeople) {
      const jid = p.jid.trim();
      if (!jid) continue;
      const entry = { jid, kind: 'person' };
      const label = p.label.trim();
      if (label) entry.label = label;
      chats.push(entry);
    }
    try {
      await api('/readable-chats', { method: 'PUT', body: JSON.stringify({ chats }) });
      await loadReadTab();
    } catch (err) {
      alert(err.message);
    }
  });

  function renderInboundFilterOptions() {
    const sel = $('inbound-filter-chat');
    const prev = state.inboundFilterJid;
    clear(sel);
    sel.appendChild(el('option', { text: 'All chats', attrs: { value: '' } }));
    for (const c of state.readableChats) {
      const label =
        c.kind === 'group'
          ? c.subject || c.jid
          : c.label || c.jid;
      sel.appendChild(el('option', { text: label, attrs: { value: c.jid } }));
    }
    sel.value = prev;
    state.inboundFilterJid = sel.value;
  }

  $('inbound-filter-chat').addEventListener('change', (e) => {
    state.inboundFilterJid = e.target.value;
    loadInbound();
  });

  $('inbound-filter-fromme').addEventListener('change', (e) => {
    state.inboundFilterFromMe = e.target.checked;
    loadInbound();
  });

  $('refresh-inbound').addEventListener('click', loadInbound);

  async function loadInbound() {
    const params = new URLSearchParams({ limit: '100' });
    if (state.inboundFilterJid) params.set('jid', state.inboundFilterJid);
    if (!state.inboundFilterFromMe) params.set('fromMe', 'false');
    try {
      const j = await api(`/inbound?${params}`);
      renderInbound(j.messages);
    } catch (err) {
      if (err.status === 401) showLogin();
    }
  }

  function chatLabelFor(jid) {
    const c = state.readableChats.find((x) => x.jid === jid);
    if (!c) return jid;
    if (c.kind === 'group') return c.subject || jid;
    return c.label || jid;
  }

  function renderInbound(messages) {
    const list = $('inbound-list');
    clear(list);
    if (messages.length === 0) {
      list.appendChild(el('p', { cls: 'muted', text: 'No captured messages yet.' }));
      return;
    }
    for (const m of messages) {
      const headChildren = [
        el('span', { cls: 'item-name', text: chatLabelFor(m.chat_jid) }),
      ];
      if (m.media_type) {
        headChildren.push(el('span', { cls: 'inbound-media', text: m.media_type }));
      }
      headChildren.push(
        el('span', { cls: 'msg', text: fmtTime(m.timestamp) })
      );
      const head = el('div', { cls: 'item-head', children: headChildren });
      const meta = el('div', {
        cls: 'item-meta',
        text: `${m.from_me ? 'me' : m.sender_jid || '(unknown)'}${
          m.quoted_wa_id ? ' • reply' : ''
        }`,
      });
      const children = [head, meta];
      if (m.text) {
        children.push(el('div', { cls: 'inbound-text', text: m.text }));
      }
      list.appendChild(
        el('div', { cls: m.from_me ? 'item inbound-mine' : 'item', children })
      );
    }
  }

  let editingProjectId = null;

  function openProjectModal(project) {
    editingProjectId = project ? project.id : null;
    $('project-modal-title').textContent = project ? `Edit "${project.name}"` : 'New project';
    $('project-name').value = project ? project.name : '';
    $('project-name').disabled = Boolean(project);

    const container = $('project-groups');
    clear(container);
    const selected = new Set(project ? project.groupJids : []);
    const allowedGroups = state.groups.filter((g) => state.allowlist.has(g.jid));
    if (allowedGroups.length === 0) {
      container.appendChild(
        el('p', {
          cls: 'muted',
          text: 'No groups in allowlist. Tick groups under "Allowlist" first.',
        })
      );
    } else {
      for (const g of allowedGroups) {
        const cb = el('input', {
          attrs: { type: 'checkbox', 'data-jid': g.jid },
        });
        if (selected.has(g.jid)) cb.checked = true;
        container.appendChild(
          el('label', {
            children: [cb, el('span', { text: `${g.subject || '(no subject)'} — ${g.jid}` })],
          })
        );
      }
    }
    $('project-modal').hidden = false;
  }

  function closeProjectModal() {
    editingProjectId = null;
    $('project-modal').hidden = true;
  }

  $('project-cancel').addEventListener('click', closeProjectModal);
  $('new-project').addEventListener('click', () => openProjectModal(null));

  $('project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('project-name').value.trim();
    const groupJids = [];
    document
      .querySelectorAll('#project-groups input[type="checkbox"]')
      .forEach((cb) => {
        if (cb.checked) groupJids.push(cb.getAttribute('data-jid'));
      });

    try {
      if (editingProjectId == null) {
        const created = await api('/projects', {
          method: 'POST',
          body: JSON.stringify({ name, groupJids }),
        });
        closeProjectModal();
        await loadProjects();
        showToken('Project created', `Token for "${created.name}":`, created.token);
      } else {
        await api(`/projects/${editingProjectId}/groups`, {
          method: 'PUT',
          body: JSON.stringify({ groupJids }),
        });
        closeProjectModal();
        await loadProjects();
      }
    } catch (err) {
      alert(err.message);
    }
  });

  async function rotateToken(p) {
    if (!confirm(`Rotate token for "${p.name}"? The old token will stop working immediately.`)) {
      return;
    }
    try {
      const j = await api(`/projects/${p.id}/rotate-token`, { method: 'POST' });
      showToken('Token rotated', `New token for "${p.name}":`, j.token);
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteProject(p) {
    if (!confirm(`Delete project "${p.name}"? This cannot be undone.`)) return;
    try {
      await api(`/projects/${p.id}`, { method: 'DELETE' });
      await loadProjects();
    } catch (err) {
      alert(err.message);
    }
  }

  function showToken(title, body, token) {
    $('modal-title').textContent = title;
    $('modal-body').textContent = body;
    $('modal-token').textContent = token;
    $('modal').hidden = false;
  }

  $('modal-close').addEventListener('click', () => {
    $('modal').hidden = true;
  });

  $('modal-copy').addEventListener('click', async () => {
    const token = $('modal-token').textContent;
    try {
      await navigator.clipboard.writeText(token);
      $('modal-copy').textContent = 'Copied';
      setTimeout(() => ($('modal-copy').textContent = 'Copy'), 1500);
    } catch {
      $('modal-copy').textContent = 'Copy failed';
    }
  });

  refreshStatus();
  setInterval(refreshStatus, 15_000);

  if (state.token) {
    (async () => {
      try {
        await api('/projects');
        showApp();
        await loadAll();
      } catch {
        showLogin();
      }
    })();
  } else {
    showLogin();
  }
})();
