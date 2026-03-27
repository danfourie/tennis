/**
 * notifications.js — In-app notification system (Firestore-backed)
 *
 * Stores one document per recipient in /notifications/{id}.
 * A real-time onSnapshot listener updates the bell badge and panel live.
 * On login, checkPendingReminders() auto-creates score_reminder and
 * league_start_reminder documents if not already sent.
 *
 * Public API:
 *   NotificationService.init()
 *   NotificationService.loadForCurrentUser()
 *   NotificationService.unload()
 *   NotificationService.markRead(id)
 *   NotificationService.markAllRead()
 *   NotificationService.send({ type, title, body, recipientUids, leagueId?, fixtureId? })
 *   NotificationService.sendToSchool(schoolId, payload)
 *   NotificationService.sendToSchoolGroup(schoolIds, payload)
 *   NotificationService.sendToLeagueParticipants(leagueId, payload)
 *   NotificationService.sendToAll(payload)
 *   NotificationService.sendGeneral(title, body, groupType, groupId)
 *   NotificationService.checkPendingReminders()
 *   NotificationService.renderComposer()
 */

const NotificationService = (() => {

  let _unsubscribe = null;   // Firestore listener unsubscribe
  let _notifs      = [];     // in-memory notifications for current user

  // ── Init (wire static UI handlers once) ─────────────────────
  function init() {
    const bell = document.getElementById('notifBell');
    if (bell) {
      bell.addEventListener('click', e => {
        e.stopPropagation();
        _togglePanel();
      });
    }

    const markAll = document.getElementById('notifMarkAll');
    if (markAll) {
      markAll.addEventListener('click', () => markAllRead());
    }

    // Close panel when clicking anywhere outside it
    document.addEventListener('click', e => {
      const panel = document.getElementById('notifPanel');
      if (panel && !panel.classList.contains('hidden') &&
          !panel.contains(e.target) &&
          e.target.id !== 'notifBell' &&
          !e.target.closest('#notifBell')) {
        panel.classList.add('hidden');
      }
    });

    _initContextModal();
  }

  // ── Context notification modal ───────────────────────────────
  let _ctxConfig = null;

  function _initContextModal() {
    const typeSel = document.getElementById('notifCtxType');
    if (typeSel) typeSel.addEventListener('change', _onCtxTypeChange);
    const sendBtn = document.getElementById('notifCtxSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', _onCtxSend);
  }

  /**
   * Open the reusable notification context modal.
   * config: { title, types: [{ value, label, subject, body, recipientLabel, schoolSelect?, sendFn }] }
   * sendFn receives (title, body, selectedSchoolIds?) and should call the appropriate send helper.
   */
  function openContextModal(config) {
    _ctxConfig = config;
    const titleEl = document.getElementById('notifCtxTitle');
    if (titleEl) titleEl.textContent = config.title || 'Send Notification';

    const typeSel = document.getElementById('notifCtxType');
    if (typeSel) {
      typeSel.innerHTML = config.types.map(t =>
        `<option value="${esc(t.value)}">${esc(t.label)}</option>`
      ).join('');
    }
    _onCtxTypeChange();
    Modal.open('notifContextModal');
  }

  function _onCtxTypeChange() {
    if (!_ctxConfig) return;
    const typeSel     = document.getElementById('notifCtxType');
    const selectedType = typeSel ? typeSel.value : null;
    const typeConfig  = _ctxConfig.types.find(t => t.value === selectedType);
    if (!typeConfig) return;

    const subjectEl = document.getElementById('notifCtxSubject');
    const bodyEl    = document.getElementById('notifCtxBody');
    const recEl     = document.getElementById('notifCtxRecipients');

    if (subjectEl) subjectEl.value   = typeConfig.subject || '';
    if (bodyEl)    bodyEl.value      = typeConfig.body    || '';
    if (recEl)     recEl.textContent = typeConfig.recipientLabel || '';

    const schoolGroup = document.getElementById('notifCtxSchoolSelectGroup');
    if (schoolGroup) {
      const show = !!typeConfig.schoolSelect;
      schoolGroup.classList.toggle('hidden', !show);
      if (show) {
        const checkboxesEl = document.getElementById('notifCtxSchoolCheckboxes');
        if (checkboxesEl) {
          const schools = DB.getSchools();
          checkboxesEl.innerHTML = schools.map(s =>
            `<label class="notif-ctx-school-label">
               <input type="checkbox" class="notif-ctx-school-cb" value="${esc(s.id)}" checked>
               <span class="color-dot" style="background:${s.color};flex-shrink:0"></span> ${esc(s.name)}
             </label>`
          ).join('');
        }
      }
    }
  }

  async function _onCtxSend() {
    if (!_ctxConfig) return;
    const typeSel     = document.getElementById('notifCtxType');
    const selectedType = typeSel ? typeSel.value : null;
    const typeConfig  = _ctxConfig.types.find(t => t.value === selectedType);
    if (!typeConfig) return;

    const title = (document.getElementById('notifCtxSubject') || {}).value?.trim() || '';
    const body  = (document.getElementById('notifCtxBody')    || {}).value?.trim() || '';
    if (!title || !body) { toast('Title and message are required', 'error'); return; }

    let selectedSchoolIds = null;
    if (typeConfig.schoolSelect) {
      selectedSchoolIds = [...document.querySelectorAll('.notif-ctx-school-cb:checked')].map(cb => cb.value);
      if (selectedSchoolIds.length === 0) { toast('Select at least one school', 'error'); return; }
    }

    const sendBtn = document.getElementById('notifCtxSendBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }

    try {
      await typeConfig.sendFn(title, body, selectedSchoolIds);
      toast('Notification sent ✓', 'success');
      Modal.close('notifContextModal');
    } catch (err) {
      console.error('[NotificationService] context send error:', err);
      toast('Failed to send notification', 'error');
    } finally {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send 🔔'; }
    }
  }

  // ── Load / unload ────────────────────────────────────────────
  function loadForCurrentUser() {
    unload();
    const profile = Auth.getProfile();
    if (!profile) return;

    _unsubscribe = DB.subscribeNotifications(profile.uid, notifs => {
      _notifs = notifs;
      _refreshBadge();
      // Only refresh panel if it is currently open
      const panel = document.getElementById('notifPanel');
      if (panel && !panel.classList.contains('hidden')) _refreshPanel();
    });

    // Run reminder checks in the background — don't await
    checkPendingReminders();
  }

  function unload() {
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    _notifs = [];
    _refreshBadge();
    const panel = document.getElementById('notifPanel');
    if (panel) panel.classList.add('hidden');
    const list = document.getElementById('notifList');
    if (list) list.innerHTML = '';
  }

  // ── Badge ───────────────────────────────────────────────────
  function _refreshBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    const count = _notifs.filter(n => !n.read).length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
  }

  // ── Panel ───────────────────────────────────────────────────
  function _togglePanel() {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    if (willOpen) _refreshPanel();
  }

  let _showReadNotifs = false;

  function _refreshPanel() {
    const list = document.getElementById('notifList');
    if (!list) return;

    const unread = _notifs.filter(n => !n.read);
    const read   = _notifs.filter(n =>  n.read);

    if (_notifs.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
      return;
    }

    const _itemHtml = n => {
      const fromHtml = n.fromName
        ? `<div class="notif-item-from">From: ${esc(n.fromName)}</div>`
        : '';
      const replyCtxHtml = n.replyContext
        ? `<div class="notif-reply-context">↩ ${esc(n.replyContext.slice(0, 100))}${n.replyContext.length > 100 ? '…' : ''}</div>`
        : '';
      const canReply = !!n.createdBy;
      return `
        <div class="notif-item${n.read ? '' : ' unread'}" data-id="${esc(n.id)}" data-league="${esc(n.leagueId || '')}" data-fixture="${esc(n.fixtureId || '')}">
          <div class="notif-item-title">${_typeIcon(n.type)} ${esc(n.title)}</div>
          ${fromHtml}
          ${replyCtxHtml}
          <div class="notif-item-body">${esc(n.body)}</div>
          <div class="notif-item-footer">
            <div class="notif-item-time">${_relativeTime(n.createdAt)}</div>
            ${canReply ? `<button class="btn btn-xs btn-secondary notif-reply-btn" data-notif-id="${esc(n.id)}">↩ Reply</button>` : ''}
          </div>
          <div class="notif-reply-form hidden" id="notif-reply-form-${esc(n.id)}">
            <textarea class="notif-reply-textarea" placeholder="Write your reply…" rows="2"></textarea>
            <div style="display:flex;gap:.35rem;margin-top:.35rem;justify-content:flex-end">
              <button class="btn btn-xs btn-secondary notif-reply-cancel" data-notif-id="${esc(n.id)}">Cancel</button>
              <button class="btn btn-xs btn-primary notif-reply-send" data-notif-id="${esc(n.id)}">Send ↩</button>
            </div>
          </div>
        </div>`;
    };

    let html = unread.length === 0
      ? '<div class="notif-empty">No new notifications</div>'
      : unread.map(_itemHtml).join('');

    if (read.length > 0) {
      if (_showReadNotifs) {
        html += `<div class="notif-read-divider">
          <button class="notif-read-toggle" id="notifReadToggle">▲ Hide read messages (${read.length})</button>
        </div>`;
        html += read.map(_itemHtml).join('');
      } else {
        html += `<div class="notif-read-divider">
          <button class="notif-read-toggle" id="notifReadToggle">▼ Show read messages (${read.length})</button>
        </div>`;
      }
    }

    list.innerHTML = html;

    const toggle = list.querySelector('#notifReadToggle');
    if (toggle) {
      toggle.addEventListener('click', e => {
        e.stopPropagation();
        _showReadNotifs = !_showReadNotifs;
        _refreshPanel();
      });
    }

    // Navigate to league/fixture on notification click
    list.querySelectorAll('.notif-item').forEach(item => {
      item.addEventListener('click', e => {
        if (e.target.closest('.notif-reply-btn, .notif-reply-cancel, .notif-reply-send, .notif-reply-form')) return;
        const id        = item.dataset.id;
        const leagueId  = item.dataset.league;
        const fixtureId = item.dataset.fixture || null;
        markRead(id);
        if (leagueId) {
          const panel = document.getElementById('notifPanel');
          if (panel) panel.classList.add('hidden');
          navigate('leagues');
          const league = DB.getLeagues().find(l => l.id === leagueId);
          if (league) Leagues.openLeagueDetail(leagueId, Auth.isAdmin(), true, fixtureId);
        }
      });
    });

    // Reply button: show/hide inline form
    list.querySelectorAll('.notif-reply-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const form = document.getElementById('notif-reply-form-' + btn.dataset.notifId);
        if (form) {
          form.classList.toggle('hidden');
          if (!form.classList.contains('hidden')) form.querySelector('textarea')?.focus();
        }
      });
    });

    // Cancel reply
    list.querySelectorAll('.notif-reply-cancel').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const form = document.getElementById('notif-reply-form-' + btn.dataset.notifId);
        if (form) form.classList.add('hidden');
      });
    });

    // Send reply
    list.querySelectorAll('.notif-reply-send').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const notifId = btn.dataset.notifId;
        const n = _notifs.find(x => x.id === notifId);
        if (!n) return;
        const form     = document.getElementById('notif-reply-form-' + notifId);
        const textarea = form ? form.querySelector('textarea') : null;
        const message  = textarea ? textarea.value.trim() : '';
        if (!message) { toast('Write a reply first', 'error'); return; }
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          _sendReply(n, message);
          toast('Reply sent ✓', 'success');
          if (form) form.classList.add('hidden');
          if (textarea) textarea.value = '';
        } catch (err) {
          console.error('[NotificationService] reply error:', err);
          toast('Failed to send reply', 'error');
        } finally {
          btn.disabled = false; btn.textContent = 'Send ↩';
        }
      });
    });
  }

  /** Send a reply back to whoever created the original notification. */
  function _sendReply(original, message) {
    if (!original.createdBy) return;
    send({
      type:         'general_message',
      title:        `Re: ${original.title}`,
      body:         message,
      recipientUids: [original.createdBy],
      leagueId:     original.leagueId  || null,
      fixtureId:    original.fixtureId || null,
      replyToId:    original.id,
      replyContext: original.body.length > 120
        ? original.body.slice(0, 117) + '…'
        : original.body,
    });
  }

  // ── Mark read ────────────────────────────────────────────────
  function markRead(id) {
    const n = _notifs.find(n => n.id === id);
    if (!n || n.read) return;
    n.read = true;
    DB.markNotificationRead(id);
    _refreshBadge();
    _refreshPanel();
  }

  function markAllRead() {
    const unread = _notifs.filter(n => !n.read);
    if (unread.length === 0) return;
    unread.forEach(n => { n.read = true; });
    DB.markAllNotificationsRead(unread.map(n => n.id));
    _refreshBadge();
    _refreshPanel();
  }

  // ── Core send ────────────────────────────────────────────────
  /**
   * Write one /notifications document per recipient uid.
   * Fire-and-forget — no return value.
   */
  function send(payload) {
    const {
      type, title, body, recipientUids,
      leagueId     = null,
      fixtureId    = null,
      replyToId    = null,   // id of the notification being replied to
      replyContext = null,   // short excerpt of the original message
      // eslint-disable-next-line no-unused-vars
      ...extraFields         // pass-through: homeTeam, awayTeam, date, homeSchoolId, etc.
    } = payload;
    if (!recipientUids || recipientUids.length === 0) return;
    const profile   = Auth.getProfile();
    const createdBy = profile ? profile.uid : null;
    const fromName  = profile ? (profile.displayName || profile.email || null) : null;
    const now       = new Date().toISOString();

    recipientUids.forEach(recipientUid => {
      if (!recipientUid) return;
      DB.writeNotification({
        ...extraFields,       // extra type-specific fields (homeTeam, awayTeam, date, …)
        id:           uid(),
        uid:          recipientUid,
        type,
        title,
        body,
        read:         false,
        leagueId,
        fixtureId,
        createdAt:    now,
        createdBy,
        fromName,
        replyToId,
        replyContext,
      });
    });
  }

  // ── Ensure users cache is populated ─────────────────────────
  async function _ensureUsers() {
    if (DB.getUsers().length === 0) await DB.loadUsers();
  }

  /**
   * Normalise a phone number to E.164 (+27...) for comparison.
   * Returns null if the input is blank or unrecognisable.
   */
  function _normPhone(phone) {
    if (!phone) return null;
    const c = String(phone).replace(/[\s\-\(\)\.]/g, '');
    if (c.startsWith('+'))  return c;
    if (c.startsWith('27')) return '+' + c;
    if (c.startsWith('0'))  return '+27' + c.slice(1);
    return c.length >= 7 ? c : null;
  }

  /**
   * Resolve UIDs for a list of school IDs.
   * Primary  : users whose `schoolId` field matches.
   * Secondary: users whose email OR phone matches a school organizer entry.
   *
   * The secondary lookup is necessary when a user is a school contact
   * (listed as organizer) but has not set their schoolId in their profile
   * (e.g. master/admin accounts used during setup or testing).
   */
  function _uidsForSchools(schoolIds) {
    const allUsers = DB.getUsers();
    const uidSet   = new Set();

    // Primary: explicit schoolId link
    allUsers.filter(u => schoolIds.includes(u.schoolId)).forEach(u => uidSet.add(u.uid));

    // Secondary: email / phone match against school organizer list
    DB.getSchools()
      .filter(s => schoolIds.includes(s.id))
      .forEach(school => {
        (school.organizers || []).forEach(org => {
          const orgEmail = (org.email || '').toLowerCase();
          const orgPhone = _normPhone(org.phone);

          allUsers.forEach(u => {
            if (orgEmail && u.email && u.email.toLowerCase() === orgEmail) uidSet.add(u.uid);
            if (orgPhone && u.phone && _normPhone(u.phone) === orgPhone)   uidSet.add(u.uid);
          });
        });
      });

    return [...uidSet];
  }

  // ── Target helpers ───────────────────────────────────────────
  async function sendToSchool(schoolId, payload) {
    if (!schoolId) return;
    await _ensureUsers();
    send({ ...payload, recipientUids: _uidsForSchools([schoolId]) });
  }

  async function sendToSchoolGroup(schoolIds, payload) {
    const ids = Array.isArray(schoolIds) ? schoolIds : [schoolIds];
    await _ensureUsers();
    send({ ...payload, recipientUids: _uidsForSchools(ids) });
  }

  async function sendToLeagueParticipants(leagueId, payload) {
    const league = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const schoolIds = [...new Set((league.participants || []).map(p => p.schoolId))];
    await sendToSchoolGroup(schoolIds, payload);
  }

  async function sendToAll(payload) {
    await _ensureUsers();
    send({ ...payload, recipientUids: DB.getUsers().map(u => u.uid) });
  }

  async function sendToMasters(payload) {
    await _ensureUsers();
    const uids = DB.getUsers().filter(u => u.role === 'master' || u.role === 'admin').map(u => u.uid);
    send({ ...payload, recipientUids: uids });
  }

  // ── School notifications (admin impersonation view) ──────────
  /**
   * Fetch all notifications addressed to users of a given school.
   * Requires master role (Firestore rules allow master to read all notifications).
   */
  async function fetchForSchool(schoolId) {
    await DB.loadUsers();   // always reload to get fresh data
    const uids = DB.getUsers().filter(u => u.schoolId === schoolId).map(u => u.uid);

    const db = firebase.firestore();

    if (uids.length === 0) {
      // No school-specific users — fall back to the current admin's own notifications.
      // The admin receives a copy of every broadcast ("send to all"), so this shows
      // everything sent without requiring elevated read permissions on other users' docs.
      const profile = Auth.getProfile();
      const adminUid = profile ? profile.uid : null;
      if (!adminUid) return { noUsers: true, items: [] };
      const snap = await db.collection('notifications').where('uid', '==', adminUid).get();
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return { noUsers: true, items: all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 50) };
    }

    const chunks = [];
    for (let i = 0; i < uids.length; i += 10) chunks.push(uids.slice(i, i + 10));

    const snaps = await Promise.all(
      chunks.map(chunk => db.collection('notifications').where('uid', 'in', chunk).get())
    );
    const all = [];
    snaps.forEach(s => s.docs.forEach(d => all.push({ id: d.id, ...d.data() })));
    return { noUsers: false, items: all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 50) };
  }

  /**
   * Render notifications for a school into a container element.
   * Used by the My School impersonation view.
   */
  async function renderSchoolNotifications(schoolId, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<p class="text-muted" style="padding:.4rem 0;font-style:italic">Loading…</p>`;
    try {
      const result = await fetchForSchool(schoolId);
      const notifs = result.items;
      const noUsersBanner = result.noUsers
        ? `<p class="text-muted" style="padding:.2rem 0 .6rem;font-style:italic;font-size:.85rem">⚠️ No registered users for this school yet — showing all sent notifications.</p>`
        : '';
      if (notifs.length === 0) {
        el.innerHTML = noUsersBanner + `<p class="text-muted" style="padding:.4rem 0;font-style:italic">No notifications have been sent yet.</p>`;
        return;
      }
      el.innerHTML = noUsersBanner + notifs.map(n => `
        <div class="notif-item${n.read ? '' : ' unread'}">
          <div class="notif-item-title">${_typeIcon(n.type)} ${esc(n.title)}</div>
          <div class="notif-item-body">${esc(n.body)}</div>
          <div class="notif-item-time">${_relativeTime(n.createdAt)} · ${n.read ? '✓ Read' : '● Unread'}</div>
        </div>`).join('');
    } catch (err) {
      console.error('[NotificationService] renderSchoolNotifications error:', err);
      el.innerHTML = `<p class="text-muted" style="padding:.4rem 0">Could not load notifications: ${esc(err.message)}</p>`;
    }
  }

  // ── Admin general message ────────────────────────────────────
  async function sendGeneral(title, body, groupType, groupId) {
    if (!title || !body) { toast('Title and message are required', 'error'); return; }
    const payload = { type: 'general_message', title, body };

    let groupLabel = 'All users';
    if (groupType === 'all') {
      await sendToAll(payload);
    } else if (groupType === 'school') {
      const school = DB.getSchools().find(s => s.id === groupId);
      groupLabel = school ? `School: ${school.name}` : 'School';
      await sendToSchool(groupId, payload);
    } else if (groupType === 'league') {
      const league = DB.getLeagues().find(l => l.id === groupId);
      groupLabel = league ? `League: ${league.name}` : 'League';
      await sendToLeagueParticipants(groupId, payload);
    }

    DB.writeAudit('notification_sent', 'notification',
      `General notification sent to ${groupLabel}: "${title}"`);

    toast('Notification sent ✓', 'success');
    const titleEl = document.getElementById('notifTitle');
    const bodyEl  = document.getElementById('notifBody');
    if (titleEl) titleEl.value = '';
    if (bodyEl)  bodyEl.value  = '';
  }

  // ── Pending reminder checks (on login) ───────────────────────
  async function checkPendingReminders() {
    const profile = Auth.getProfile();
    if (!profile) return;

    const myUid   = profile.uid;
    const today   = toDateStr(new Date());
    const in7days = toDateStr(addDays(new Date(), 7));

    // Build the full set of school IDs this user is associated with.
    // Primary  : profile.schoolId (explicit link)
    // Secondary: any school where the user's email or phone is listed as
    //            an organizer — catches admin/master users who are school
    //            contacts but haven't set schoolId in their profile.
    const mySchoolIds = new Set();
    if (profile.schoolId) mySchoolIds.add(profile.schoolId);

    const myEmail = (profile.email || '').toLowerCase();
    const myPhone = _normPhone(profile.phone || '');
    DB.getSchools().forEach(s => {
      (s.organizers || []).forEach(org => {
        const orgEmail = (org.email || '').toLowerCase();
        const orgPhone = _normPhone(org.phone);
        if ((myEmail && orgEmail && myEmail === orgEmail) ||
            (myPhone && orgPhone && myPhone === orgPhone)) {
          mySchoolIds.add(s.id);
        }
      });
    });

    // For backward compat keep a single value for simple comparisons
    const mySchoolId = profile.schoolId || null;

    // Fetch existing reminder notifications for this user to avoid duplicates
    let existing = [];
    try {
      const snap = await firebase.firestore()
        .collection('notifications')
        .where('uid',  '==', myUid)
        .where('type', 'in', ['score_reminder', 'league_start_reminder'])
        .get();
      existing = snap.docs.map(d => d.data());
    } catch (err) {
      console.warn('[NotificationService] checkPendingReminders query failed:', err);
      return;
    }

    const alreadyForFixture = fid => existing.some(n => n.type === 'score_reminder'        && n.fixtureId === fid);
    const alreadyForLeague  = lid => existing.some(n => n.type === 'league_start_reminder' && n.leagueId  === lid);

    const now      = new Date().toISOString();
    const newNotifs = [];

    // ── Overdue scores ─────────────────────────────────────────
    for (const league of DB.getLeagues()) {
      for (const f of (league.fixtures || [])) {
        if (!f.date || f.date >= today) continue;
        if (f.homeScore !== null && f.homeScore !== undefined) continue;
        // User must be associated with at least one of the fixture's schools
        if (!mySchoolIds.has(f.homeSchoolId) && !mySchoolIds.has(f.awaySchoolId)) continue;
        if (alreadyForFixture(f.id)) continue;

        newNotifs.push({
          id:           uid(),
          uid:          myUid,
          type:         'score_reminder',
          title:        'Score not submitted',
          body:         `${f.homeSchoolName || 'Home'} vs ${f.awaySchoolName || 'Away'} on ${formatDate(f.date)} — please reply with the score (e.g. 6-3) or log in to enter it.`,
          read:         false,
          leagueId:     league.id,
          fixtureId:    f.id,
          homeTeam:     f.homeSchoolName  || 'Home',
          awayTeam:     f.awaySchoolName  || 'Away',
          date:         f.date            || '',   // needed for score_reminder template {{3}}
          homeSchoolId: f.homeSchoolId    || null,
          awaySchoolId: f.awaySchoolId    || null,
          createdAt:    now,
          createdBy:    null,
        });
      }
    }

    // ── Upcoming league starts (within 7 days) ─────────────────
    for (const league of DB.getLeagues()) {
      if (!league.startDate) continue;
      if (league.startDate < today || league.startDate > in7days) continue;
      const isParticipant = (league.participants || []).some(p => mySchoolIds.has(p.schoolId));
      if (!isParticipant) continue;
      if (alreadyForLeague(league.id)) continue;

      newNotifs.push({
        id:        uid(),
        uid:       myUid,
        type:      'league_start_reminder',
        title:     `League starting soon: ${league.name}`,
        body:      `${league.name}${league.division ? ' · ' + league.division : ''} starts on ${formatDate(league.startDate)}. Check your fixtures.`,
        read:      false,
        leagueId:  league.id,
        fixtureId: null,
        createdAt: now,
        createdBy: null,
      });
    }

    newNotifs.forEach(n => DB.writeNotification(n));

    if (newNotifs.length > 0) {
      const scoreCount  = newNotifs.filter(n => n.type === 'score_reminder').length;
      const leagueCount = newNotifs.filter(n => n.type === 'league_start_reminder').length;
      const parts = [];
      if (scoreCount)  parts.push(`${scoreCount} score reminder${scoreCount > 1 ? 's' : ''}`);
      if (leagueCount) parts.push(`${leagueCount} league start reminder${leagueCount > 1 ? 's' : ''}`);
      DB.writeAudit('reminders_sent', 'notification',
        `Auto-reminders sent: ${parts.join(', ')}`);
    }
  }

  // ── Admin composer dropdown population ───────────────────────
  function renderComposer() {
    const sel = document.getElementById('notifRecipientGroup');
    if (!sel) return;

    const schools = DB.getSchools();
    const leagues = DB.getLeagues();

    sel.innerHTML =
      `<option value="all">📣 All Users</option>` +
      (schools.length ? `<optgroup label="By School">` +
        schools.map(s => `<option value="school:${esc(s.id)}">🏫 ${esc(s.name)}</option>`).join('') +
        `</optgroup>` : '') +
      (leagues.length ? `<optgroup label="By League">` +
        leagues.map(l => `<option value="league:${esc(l.id)}">🏆 ${esc(l.name)}${l.division ? ' · ' + esc(l.division) : ''}</option>`).join('') +
        `</optgroup>` : '');
  }

  // ── Helpers ──────────────────────────────────────────────────
  function _relativeTime(isoStr) {
    if (!isoStr) return '';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins  = Math.floor(diff / 60000);
    if (mins < 1)   return 'just now';
    if (mins < 60)  return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs  < 24)  return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7)   return `${days}d ago`;
    return formatDate(isoStr.slice(0, 10));
  }

  function _typeIcon(type) {
    const icons = {
      score_reminder:              '⏰',
      league_created:              '🏆',
      league_start_reminder:       '📅',
      fixture_changed:             '📋',
      fixture_cancelled:           '❌',
      general_message:             '📢',
      team_registration_reminder:  '📝',
      league_entry:                '📝',
      booking_request:             '📩',
      booking_approved:            '✅',
      booking_rejected:            '❌',
    };
    return icons[type] || '🔔';
  }

  return {
    init,
    loadForCurrentUser,
    unload,
    markRead,
    markAllRead,
    send,
    sendToSchool,
    sendToSchoolGroup,
    sendToLeagueParticipants,
    sendToAll,
    sendToMasters,
    fetchForSchool,
    renderSchoolNotifications,
    sendGeneral,
    checkPendingReminders,
    renderComposer,
    openContextModal,
  };
})();
