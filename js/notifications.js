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

  function _refreshPanel() {
    const list = document.getElementById('notifList');
    if (!list) return;

    if (_notifs.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
      return;
    }

    list.innerHTML = _notifs.map(n => `
      <div class="notif-item${n.read ? '' : ' unread'}" data-id="${esc(n.id)}" data-league="${esc(n.leagueId || '')}">
        <div class="notif-item-title">${_typeIcon(n.type)} ${esc(n.title)}</div>
        <div class="notif-item-body">${esc(n.body)}</div>
        <div class="notif-item-time">${_relativeTime(n.createdAt)}</div>
      </div>`).join('');

    list.querySelectorAll('.notif-item').forEach(item => {
      item.addEventListener('click', () => {
        const id       = item.dataset.id;
        const leagueId = item.dataset.league;
        markRead(id);
        if (leagueId) {
          const panel = document.getElementById('notifPanel');
          if (panel) panel.classList.add('hidden');
          navigate('leagues');
          const league = DB.getLeagues().find(l => l.id === leagueId);
          if (league) Leagues.openLeagueDetail(leagueId, Auth.isAdmin());
        }
      });
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
    const { type, title, body, recipientUids, leagueId = null, fixtureId = null } = payload;
    if (!recipientUids || recipientUids.length === 0) return;
    const profile   = Auth.getProfile();
    const createdBy = profile ? profile.uid : null;
    const now       = new Date().toISOString();

    recipientUids.forEach(recipientUid => {
      if (!recipientUid) return;
      DB.writeNotification({
        id:        uid(),
        uid:       recipientUid,
        type,
        title,
        body,
        read:      false,
        leagueId,
        fixtureId,
        createdAt: now,
        createdBy,
      });
    });
  }

  // ── Ensure users cache is populated ─────────────────────────
  async function _ensureUsers() {
    if (DB.getUsers().length === 0) await DB.loadUsers();
  }

  // ── Target helpers ───────────────────────────────────────────
  async function sendToSchool(schoolId, payload) {
    if (!schoolId) return;
    await _ensureUsers();
    const uids = DB.getUsers()
      .filter(u => u.schoolId === schoolId)
      .map(u => u.uid);
    send({ ...payload, recipientUids: uids });
  }

  async function sendToSchoolGroup(schoolIds, payload) {
    const ids = Array.isArray(schoolIds) ? schoolIds : [schoolIds];
    await _ensureUsers();
    const uids = [...new Set(
      DB.getUsers().filter(u => ids.includes(u.schoolId)).map(u => u.uid)
    )];
    send({ ...payload, recipientUids: uids });
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

  // ── Admin general message ────────────────────────────────────
  async function sendGeneral(title, body, groupType, groupId) {
    if (!title || !body) { toast('Title and message are required', 'error'); return; }
    const payload = { type: 'general_message', title, body };

    if (groupType === 'all') {
      await sendToAll(payload);
    } else if (groupType === 'school') {
      await sendToSchool(groupId, payload);
    } else if (groupType === 'league') {
      await sendToLeagueParticipants(groupId, payload);
    }

    toast('Notification sent ✓', 'success');
    const titleEl = document.getElementById('notifTitle');
    const bodyEl  = document.getElementById('notifBody');
    if (titleEl) titleEl.value = '';
    if (bodyEl)  bodyEl.value  = '';
  }

  // ── Pending reminder checks (on login) ───────────────────────
  async function checkPendingReminders() {
    const profile = Auth.getProfile();
    if (!profile || !profile.schoolId) return;

    const myUid      = profile.uid;
    const mySchoolId = profile.schoolId;
    const today      = toDateStr(new Date());
    const in7days    = toDateStr(addDays(new Date(), 7));

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
        if (f.homeSchoolId !== mySchoolId && f.awaySchoolId !== mySchoolId) continue;
        if (alreadyForFixture(f.id)) continue;

        newNotifs.push({
          id:        uid(),
          uid:       myUid,
          type:      'score_reminder',
          title:     'Score not submitted',
          body:      `${f.homeSchoolName || 'Home'} vs ${f.awaySchoolName || 'Away'} on ${formatDate(f.date)} still has no score recorded.`,
          read:      false,
          leagueId:  league.id,
          fixtureId: f.id,
          createdAt: now,
          createdBy: null,
        });
      }
    }

    // ── Upcoming league starts (within 7 days) ─────────────────
    for (const league of DB.getLeagues()) {
      if (!league.startDate) continue;
      if (league.startDate < today || league.startDate > in7days) continue;
      const isParticipant = (league.participants || []).some(p => p.schoolId === mySchoolId);
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
    sendGeneral,
    checkPendingReminders,
    renderComposer,
    openContextModal,
  };
})();
