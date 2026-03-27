// BUILD: 20260322-excluded-dates
console.log('[leagues.js] BUILD 20260322-excluded-dates loaded');
/**
 * leagues.js — School league management.
 *   Public view  : render()       → #leaguesList        (read-only / score entry)
 *   Admin view   : renderAdmin()  → #adminLeaguesList   (full CRUD + fixture editing)
 *
 * Data model (league doc):
 *   participants: [{ participantId, schoolId, teamSuffix }]
 *     - single team : participantId = schoolId,       teamSuffix = ""
 *     - two teams   : participantId = schoolId+"_A/B", teamSuffix = "A"|"B"
 *   schoolIds: derived array of unique school IDs (kept for backward compat)
 *   fixtures / standings reference participantId (homeParticipantId, awayParticipantId)
 */

const Leagues = (() => {

  // ── Division filter state ────────────────────────────────────
  let _pubDivFilter   = '';
  let _adminDivFilter = '';

  // ── Detail modal state (for live-refresh when modal is open) ─
  let _currentDetailId      = null;
  let _currentDetailIsAdmin = false;

  // ── Excluded dates for the currently-open league modal ──────
  let _excludedDates = [];

  /** Populate a division <select> from current leagues, preserving selection. */
  function _populateDivFilter(id, currentVal) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const divs = [...new Set(DB.getLeagues().map(l => l.division || '').filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All Divisions</option>' +
      divs.map(d => `<option value="${esc(d)}"${d === currentVal ? ' selected' : ''}>${esc(d)}</option>`).join('');
  }

  function init() {
    document.getElementById('leagueSubmitBtn').addEventListener('click', () => saveLeague(false));
    const saveDetailsBtn = document.getElementById('leagueSaveDetailsBtn');
    if (saveDetailsBtn) saveDetailsBtn.addEventListener('click', () => saveLeague(true));
    // Fixture edit modal save
    document.getElementById('fixtureEditSaveBtn').addEventListener('click', saveFixtureEdit);
    document.getElementById('fixtureEditVenue').addEventListener('change', _updateFixtureCourtList);
    // League entry submit
    const entrySubmitBtn = document.getElementById('leagueEntrySubmitBtn');
    if (entrySubmitBtn) entrySubmitBtn.addEventListener('click', _submitEntry);
    // Division filters
    const pubDivSel = document.getElementById('leaguesDivFilter');
    if (pubDivSel) pubDivSel.addEventListener('change', e => { _pubDivFilter = e.target.value; render(); });
    const admDivSel = document.getElementById('adminLeaguesDivFilter');
    if (admDivSel) admDivSel.addEventListener('change', e => { _adminDivFilter = e.target.value; renderAdmin(); });
    // Excluded dates: Add Date button
    const addExcludedBtn = document.getElementById('leagueAddExcludedDate');
    if (addExcludedBtn) {
      addExcludedBtn.addEventListener('click', () => {
        const picker = document.getElementById('leagueExcludedDatePicker');
        const val = picker ? picker.value : '';
        if (!val) return;
        if (!_excludedDates.includes(val)) {
          _excludedDates.push(val);
          _excludedDates.sort();
          _renderExcludedDateTags();
        }
        if (picker) picker.value = '';
      });
    }
    _initScoreSheetModal();
    render();
  }

  function refresh() {
    render();
    // If admin leagues tab is visible, refresh it too
    const adminPanel = document.getElementById('subtab-leagues');
    if (adminPanel && !adminPanel.classList.contains('hidden')) renderAdmin();
    // Live-refresh the detail modal if it is currently open (so score/standings
    // changes made in another session appear immediately without closing/reopening).
    // Pass recalc=false to avoid a Firestore write loop (onSnapshot → write → onSnapshot…).
    const detailModal = document.getElementById('leagueDetailModal');
    if (detailModal && !detailModal.classList.contains('hidden') && _currentDetailId) {
      openLeagueDetail(_currentDetailId, _currentDetailIsAdmin, false);
    }
  }

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════

  /** Return the participants array, falling back to old schoolIds format. */
  function _getParticipants(league) {
    if (league.participants && league.participants.length > 0) return league.participants;
    return (league.schoolIds || []).map(id => ({ participantId: id, schoolId: id, teamSuffix: '' }));
  }

  /** Resolve a participant to its display name (school name + optional suffix). */
  function _participantName(p) {
    const s = DB.getSchools().find(x => x.id === p.schoolId);
    if (!s) return p.participantId;
    return s.name + (p.teamSuffix ? ' ' + p.teamSuffix : '');
  }

  // ════════════════════════════════════════════════════════════
  // ENTRY HELPERS
  // ════════════════════════════════════════════════════════════

  /** True when the entry window is still open for a league. */
  function _entryOpen(league) {
    // Entries close once the league has any played fixtures (in progress or complete)
    const hasStarted = (league.fixtures || []).some(
      f => f.homeScore !== null && f.homeScore !== undefined
    );
    if (hasStarted) return false;
    // Entries also close once the entry deadline has passed
    if (league.entryDeadline) {
      const today = toDateStr(new Date());
      if (today > league.entryDeadline) return false;
    }
    return true;
  }

  /**
   * How many pending/approved entries does this school have in this league?
   * Returns { count, entries }
   */
  function _schoolEntryCount(leagueId, schoolId) {
    const entries = DB.getLeagueEntries().filter(
      e => e.leagueId === leagueId && e.schoolId === schoolId && e.status !== 'rejected'
    );
    return { count: entries.length, entries };
  }

  /** Open the entry-confirm modal pre-filled for this league. */
  function openEntryModal(leagueId) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    const profile = Auth.getProfile();
    if (!league || !profile || !profile.schoolId) return;

    const school = DB.getSchools().find(s => s.id === profile.schoolId);
    const { count } = _schoolEntryCount(leagueId, profile.schoolId);
    const slotsLeft = 2 - count;

    document.getElementById('leagueEntryLeagueId').value = leagueId;
    document.getElementById('leagueEntryModalTitle').textContent =
      count === 0 ? `Enter a Team — ${league.name}` : `Enter 2nd Team — ${league.name}`;
    document.getElementById('leagueEntryModalDesc').textContent =
      `Submitting for ${school ? school.name : 'your school'} · "${league.name}"` +
      (league.division ? ` (${league.division})` : '');

    // Clear inputs
    document.getElementById('leagueEntryTeam1Name').value = '';
    document.getElementById('leagueEntryTeam2Name').value = '';

    // Show "add second team" toggle only when entering the first time (2 slots free)
    const toggleRow = document.getElementById('leagueEntrySecondToggleRow');
    const team2Group = document.getElementById('leagueEntryTeam2Group');
    const addSecondCb = document.getElementById('leagueEntryAddSecond');

    if (slotsLeft >= 2) {
      toggleRow.classList.remove('hidden');
      addSecondCb.checked = false;
      team2Group.classList.add('hidden');
      addSecondCb.onchange = () => {
        team2Group.classList.toggle('hidden', !addSecondCb.checked);
      };
    } else {
      toggleRow.classList.add('hidden');
      team2Group.classList.add('hidden');
      addSecondCb.checked = false;
    }

    Modal.open('leagueEntryModal');
  }

  /** Called when the submit button is clicked inside the entry modal. */
  async function _submitEntry() {
    const leagueId = document.getElementById('leagueEntryLeagueId').value;
    const league   = DB.getLeagues().find(l => l.id === leagueId);
    const profile  = Auth.getProfile();
    if (!league || !profile || !profile.schoolId) return;

    const school = DB.getSchools().find(s => s.id === profile.schoolId);
    const { count } = _schoolEntryCount(leagueId, profile.schoolId);

    // Guards
    if (count >= 2) { toast('Your school already has 2 teams entered in this league', 'error'); return; }
    if (!_entryOpen(league)) { toast('Entries for this league are closed', 'error'); return; }

    const schoolName    = school ? school.name : (profile.schoolId);
    const team1RawName  = document.getElementById('leagueEntryTeam1Name').value.trim();
    const addSecond     = document.getElementById('leagueEntryAddSecond').checked && (count === 0);
    const team2RawName  = addSecond ? document.getElementById('leagueEntryTeam2Name').value.trim() : '';

    if (!team1RawName) { toast('Please enter a team name', 'error'); return; }
    if (addSecond && !team2RawName) { toast('Please enter a name for the second team', 'error'); return; }

    // Build the list of entries to submit
    const toSubmit = [{ teamName: team1RawName, suffix: count === 0 ? 'A' : 'B' }];
    if (addSecond) toSubmit.push({ teamName: team2RawName, suffix: 'B' });

    const now = new Date().toISOString();
    const btn = document.getElementById('leagueEntrySubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

    try {
      for (const t of toSubmit) {
        const teamLabel = `${schoolName} — ${t.teamName}`;
        const entry = DB.addLeagueEntry({
          leagueId,
          schoolId:      profile.schoolId,
          teamSuffix:    t.suffix,
          teamName:      t.teamName,
          teamLabel,
          status:        'pending',
          enteredBy:     profile.uid,
          enteredByName: profile.displayName || profile.email || '',
          enteredAt:     now,
        });

        DB.writeAudit('entry_submitted', 'league',
          `${teamLabel} entered ${league.name}`, entry.id, teamLabel);

        await NotificationService.sendToMasters({
          type:     'league_entry',
          title:    `New league entry: ${teamLabel}`,
          body:     `${teamLabel} has submitted an entry for "${league.name}"${league.division ? ' · ' + league.division : ''}. Please review and approve.`,
          leagueId,
        });
      }

      const msg = toSubmit.length > 1 ? '2 entries submitted — pending approval ✓' : 'Entry submitted — pending approval ✓';
      toast(msg, 'success');
      Modal.close('leagueEntryModal');
      render();
    } catch (err) {
      console.error('[Leagues] entry submit error:', err);
      toast('Failed to submit entry', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📝 Submit Entry'; }
    }
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC VIEW  (view-leagues)
  // ════════════════════════════════════════════════════════════
  /** Sort leagues newest-first (by startDate desc). */
  function _sortLeagues(leagues) {
    return [...leagues].sort((a, b) => {
      const da = a.startDate || '', db = b.startDate || '';
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db.localeCompare(da);
    });
  }

  /** Apply the current search box value to a cards grid after render. */
  function _applyCardSearch(inputId, containerSelector) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    const q = inp.value.toLowerCase().trim();
    if (!q) return;
    document.querySelectorAll(`${containerSelector} .card`).forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  /** Wire up a card-grid search input (once). */
  function _initCardSearch(inputId, containerSelector) {
    const inp = document.getElementById(inputId);
    if (!inp || inp.dataset.searchBound) return;
    inp.dataset.searchBound = '1';
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase().trim();
      document.querySelectorAll(`${containerSelector} .card`).forEach(el => {
        el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  function render() {
    const container = document.getElementById('leaguesList');
    if (!container) return;
    _populateDivFilter('leaguesDivFilter', _pubDivFilter);
    let leagues = _sortLeagues(DB.getLeagues());
    if (_pubDivFilter) leagues = leagues.filter(l => (l.division || '') === _pubDivFilter);
    if (leagues.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><p>No leagues yet.</p></div>`;
      _initCardSearch('leaguesSearch', '#leaguesList');
      return;
    }
    container.innerHTML = leagues.map(l => _leagueCard(l)).join('');
    container.querySelectorAll('[data-league-view]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueDetail(btn.dataset.leagueView));
    });
    container.querySelectorAll('[data-league-entries-quick]').forEach(btn => {
      btn.addEventListener('click', () => openEntriesModal(btn.dataset.leagueEntriesQuick));
    });
    container.querySelectorAll('[data-league-enter]').forEach(btn => {
      btn.addEventListener('click', () => openEntryModal(btn.dataset.leagueEnter));
    });
    _initCardSearch('leaguesSearch', '#leaguesList');
    _applyCardSearch('leaguesSearch', '#leaguesList');
  }

  function _leagueCard(l) {
    const parts = _getParticipants(l);
    const badges = parts.map(p => {
      const s = DB.getSchools().find(x => x.id === p.schoolId);
      if (!s) return '';
      const label = s.name + (p.teamSuffix ? ' ' + p.teamSuffix : '');
      return `<span class="badge" style="background:${s.color}22;color:${s.color};border:1px solid ${s.color}44">${esc(label)}</span>`;
    }).join('');

    const totalFixtures = l.fixtures ? l.fixtures.length : 0;
    const played = l.fixtures ? l.fixtures.filter(f => f.homeScore !== null && f.homeScore !== undefined).length : 0;
    const statusBadge = played === totalFixtures && totalFixtures > 0
      ? `<span class="badge badge-green">Complete</span>`
      : played > 0
        ? `<span class="badge badge-amber">In Progress</span>`
        : `<span class="badge badge-gray">Pending</span>`;
    const DAYS = ['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'];
    const dayLabel = l.playingDay !== undefined ? ` · ${DAYS[l.playingDay]}` : '';

    // ── Entry deadline row ────────────────────────────────────
    const entryOpen   = _entryOpen(l);
    const deadlineRow = l.entryDeadline
      ? `<div class="entry-deadline-row">
           📋 Entry deadline: <strong>${formatDate(l.entryDeadline)}</strong>
           ${entryOpen
             ? '<span class="entry-open-badge">Open for entries</span>'
             : '<span class="entry-closed-badge">Entries closed</span>'}
         </div>`
      : '';

    // ── Entry section (only for signed-in school users) ───────
    let entryBtn   = '';
    let entryList  = '';
    const profile  = typeof Auth !== 'undefined' ? Auth.getProfile() : null;
    if (profile && profile.schoolId) {
      const { count, entries } = _schoolEntryCount(l.id, profile.schoolId);
      const school = DB.getSchools().find(s => s.id === profile.schoolId);

      // Show each submitted entry as a small line with status colour
      if (entries.length > 0) {
        entryList = `<div class="entry-team-list">` +
          entries.map(e => {
            const statusIcon  = e.status === 'approved' ? '✓' : e.status === 'rejected' ? '✗' : '⏳';
            const statusClass = e.status === 'approved' ? 'entry-status--approved'
                              : e.status === 'rejected' ? 'entry-status--rejected'
                              : 'entry-status--pending';
            const label = e.teamLabel || (school ? school.name : 'Your team');
            return `<div class="entry-status-row ${statusClass}">${statusIcon} ${esc(label)}</div>`;
          }).join('') +
        `</div>`;
      }

      if (count >= 2) {
        // both slots filled — no button needed
      } else if (entryOpen) {
        const btnLabel = count === 0 ? '📝 Enter a Team' : '📝 Enter 2nd team';
        entryBtn = `<button class="btn btn-sm btn-primary" data-league-enter="${esc(l.id)}">${btnLabel}</button>`;
      }
    }

    // ── Pending entries banner (admin/master only) ────────────
    let pendingBanner = '';
    if (typeof Auth !== 'undefined' && Auth.isAdmin()) {
      const pendingCount = DB.getLeagueEntries
        ? DB.getLeagueEntries().filter(e => e.leagueId === l.id && e.status === 'pending').length
        : 0;
      if (pendingCount > 0) {
        pendingBanner = `<div class="pending-entries-banner">
          ⏳ <strong>${pendingCount} pending entr${pendingCount === 1 ? 'y' : 'ies'}</strong> awaiting approval
          <button class="btn btn-xs btn-primary" style="margin-left:.5rem" data-league-entries-quick="${l.id}">Review</button>
        </div>`;
      }
    }

    return `<div class="card${pendingBanner ? ' card--has-pending' : ''}">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(l.name)}</div>
          <div class="text-muted">${esc(l.division || '')}${dayLabel}</div>
        </div>
        ${statusBadge}
      </div>
      <div class="card-body">
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.5rem">${badges}</div>
        <div class="text-muted">${l.startDate ? formatDate(l.startDate) : '—'} → ${l.endDate ? formatDate(l.endDate) : '—'}</div>
        ${deadlineRow}
        <div class="text-muted mt-1">${totalFixtures} fixtures · ${played} played</div>
        ${pendingBanner}
        ${entryList}
      </div>
      <div class="card-footer">
        <button class="btn btn-sm btn-secondary" data-league-view="${l.id}">View Fixtures &amp; Standings</button>
        ${entryBtn}
      </div>
    </div>`;
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN VIEW  (subtab-leagues inside Admin)
  // ════════════════════════════════════════════════════════════
  function renderAdmin() {
    const container = document.getElementById('adminLeaguesList');
    if (!container) return;
    _populateDivFilter('adminLeaguesDivFilter', _adminDivFilter);
    let leagues = _sortLeagues(DB.getLeagues());
    if (_adminDivFilter) leagues = leagues.filter(l => (l.division || '') === _adminDivFilter);
    if (leagues.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><p>No leagues yet. Click <strong>+ Create League</strong> to get started.</p></div>`;
      return;
    }

    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    container.innerHTML = leagues.map(l => {
      const parts         = _getParticipants(l);
      const totalFixtures = (l.fixtures || []).length;
      const played        = (l.fixtures || []).filter(f => f.homeScore !== null && f.homeScore !== undefined).length;
      const dayLabel      = l.playingDay !== undefined ? DAYS[l.playingDay] + 's' : 'Fridays';

      const teamBadges = parts.map(p => {
        const s = DB.getSchools().find(x => x.id === p.schoolId);
        if (!s) return '';
        const label = s.name + (p.teamSuffix ? ' ' + p.teamSuffix : '');
        return `<span style="color:${s.color};margin-right:.4rem">● ${esc(label)}</span>`;
      }).join('');

      const pendingEntries = DB.getEntriesForLeague(l.id).filter(e => e.status === 'pending');
      const entryBadge = pendingEntries.length > 0
        ? ` <span class="badge badge-amber" style="font-size:.72rem">${pendingEntries.length} pending</span>`
        : '';
      const deadlineMeta = l.entryDeadline
        ? `<div class="module-meta">📋 Entry deadline: ${formatDate(l.entryDeadline)}${_entryOpen(l) ? ' · <em style="color:var(--success)">Open</em>' : ' · <em style="color:var(--danger)">Closed</em>'}</div>`
        : '';

      return `<div class="admin-module-item${pendingEntries.length > 0 ? ' admin-module-item--pending' : ''}" data-league-id="${l.id}">
        <div class="module-info">
          <div class="module-title">${esc(l.name)}${pendingEntries.length > 0 ? ` <span class="badge badge-amber" style="font-size:.72rem;vertical-align:middle">⏳ ${pendingEntries.length} pending</span>` : ''}</div>
          <div class="module-meta">
            ${esc(l.division || 'No division')}
            · ${l.startDate ? formatDate(l.startDate) : '?'} → ${l.endDate ? formatDate(l.endDate) : '?'}
            · ${dayLabel} · ${esc(l.matchTime || '14:00')}
          </div>
          <div class="module-meta" style="margin-top:.25rem">${teamBadges}</div>
          <div class="module-meta">${totalFixtures} fixtures · ${played} played · ${totalFixtures - played} remaining</div>
          ${deadlineMeta}
        </div>
        <div class="module-actions">
          <button class="btn btn-sm btn-secondary" data-admin-entries="${l.id}">📝 Entries${entryBadge}</button>
          <button class="btn btn-sm btn-secondary" data-admin-fixtures="${l.id}">📋 Manage Fixtures</button>
          <button class="btn btn-sm btn-secondary" data-admin-league-edit="${l.id}">✏️ Edit</button>
          <button class="btn btn-sm btn-secondary" data-league-notif="${l.id}">🔔 Notify</button>
          ${totalFixtures > 0 && !l.drawConfirmed && played === 0
            ? `<button class="btn btn-sm btn-success" data-confirm-draw="${l.id}">✅ Confirm Draw</button>`
            : l.drawConfirmed
              ? `<span class="badge badge-green" title="Draw confirmed — reset fixtures to unlock">🔒 Draw Confirmed</span>`
              : ''}
          <button class="btn btn-sm btn-warning" data-reset-fixtures="${l.id}"
            ${l.drawConfirmed || played > 0 ? 'disabled title="Cannot reset: draw confirmed or league has started"' : ''}>
            🔄 Reset Fixtures
          </button>
          <button class="btn btn-sm btn-danger"    data-admin-league-del="${l.id}">Delete</button>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('[data-admin-entries]').forEach(btn => {
      btn.addEventListener('click', () => openEntriesModal(btn.dataset.adminEntries));
    });
    container.querySelectorAll('[data-admin-fixtures]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueDetail(btn.dataset.adminFixtures, true));
    });
    container.querySelectorAll('[data-admin-league-edit]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueModal(btn.dataset.adminLeagueEdit));
    });
    container.querySelectorAll('[data-admin-league-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteLeague(btn.dataset.adminLeagueDel));
    });
    container.querySelectorAll('[data-confirm-draw]').forEach(btn => {
      btn.addEventListener('click', () => {
        const l = DB.getLeagues().find(x => x.id === btn.dataset.confirmDraw);
        if (!l) return;
        if (!confirm(`Confirm the draw for "${l.name}"?\n\nThis locks the fixtures. Reset Fixtures will be disabled until you explicitly reset.`)) return;
        DB.updateLeague({ ...l, drawConfirmed: true });
        toast(`Draw confirmed for ${l.name}`, 'success');
        renderAdmin();
      });
    });

    container.querySelectorAll('[data-reset-fixtures]').forEach(btn => {
      btn.addEventListener('click', () => {
        const l = DB.getLeagues().find(x => x.id === btn.dataset.resetFixtures);
        if (!l) return;
        if (l.drawConfirmed || (l.fixtures || []).some(f => f.homeScore !== null && f.homeScore !== undefined)) return;
        if (!confirm(`Reset all fixtures for "${l.name}"?\n\nThis clears fixtures, standings and draw confirmation so you can regenerate from scratch.`)) return;
        DB.updateLeague({ ...l, fixtures: [], standings: [], drawConfirmed: false });
        toast(`Fixtures cleared for ${l.name}`, 'success');
        renderAdmin();
      });
    });
    container.querySelectorAll('[data-league-notif]').forEach(btn => {
      btn.addEventListener('click', () => {
        const l = DB.getLeagues().find(x => x.id === btn.dataset.leagueNotif);
        if (!l) return;
        const parts            = _getParticipants(l);
        const schoolIds        = [...new Set(parts.map(p => p.schoolId))];
        const allSchools       = DB.getSchools();
        const participantNames = schoolIds
          .map(id => (allSchools.find(s => s.id === id) || {}).name)
          .filter(Boolean).join(', ');
        const startLabel = l.startDate ? formatDate(l.startDate) : 'TBA';

        NotificationService.openContextModal({
          title: `Notify — ${l.name}`,
          types: [
            {
              value:          'league_created',
              label:          '📢 New league created — select schools to invite',
              subject:        `New league: ${l.name}`,
              body:           `${l.name}${l.division ? ' · ' + l.division : ''} has been created and starts on ${startLabel}. Register your school to participate.`,
              recipientLabel: '📋 Select schools to notify below',
              schoolSelect:   true,
              sendFn: async (title, body, selectedSchoolIds) => {
                await NotificationService.sendToSchoolGroup(selectedSchoolIds, {
                  type: 'league_created', title, body, leagueId: l.id,
                });
              },
            },
            {
              value:          'fixture_changed',
              label:          '📋 Fixtures updated — notify all participants',
              subject:        `Fixtures updated: ${l.name}`,
              body:           `The fixtures for ${l.name} have been updated. Please check your upcoming schedule.`,
              recipientLabel: `📬 Recipients: ${participantNames || 'All participants'}`,
              sendFn: async (title, body) => {
                await NotificationService.sendToLeagueParticipants(l.id, {
                  type: 'fixture_changed', title, body, leagueId: l.id,
                });
              },
            },
            {
              value:          'score_reminder',
              label:          '⏰ Score reminder — remind all participants to submit scores',
              subject:        `Please submit your scores — ${l.name}`,
              body:           `This is a reminder to submit outstanding scores for ${l.name}. Please update your results as soon as possible.`,
              recipientLabel: `📬 Recipients: ${participantNames || 'All participants'}`,
              sendFn: async (title, body) => {
                await NotificationService.sendToLeagueParticipants(l.id, {
                  type: 'score_reminder', title, body, leagueId: l.id,
                });
              },
            },
          ],
        });
      });
    });
    // Re-apply active admin search filter
    const inp = document.getElementById('adminLeaguesSearch');
    if (inp) {
      const q = inp.value.toLowerCase().trim();
      if (q) container.querySelectorAll('.admin-module-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // ENTRIES ADMIN MODAL
  // ════════════════════════════════════════════════════════════

  function openEntriesModal(leagueId) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    document.getElementById('leagueEntriesModalTitle').textContent =
      `📝 Entries — ${league.name}`;
    _renderEntriesModal(leagueId);
    Modal.open('leagueEntriesModal');
  }

  function _renderEntriesModal(leagueId) {
    const body    = document.getElementById('leagueEntriesModalBody');
    if (!body) return;
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    const entries = DB.getEntriesForLeague(leagueId);
    const leagues = DB.getLeagues().filter(l => l.id !== leagueId);

    if (entries.length === 0) {
      body.innerHTML = `<p class="text-muted" style="padding:.5rem 0">No entries yet for this league.</p>`;
      return;
    }

    const statusBadge = s =>
      s === 'approved' ? '<span class="badge badge-green">✓ Approved</span>'
      : s === 'rejected' ? '<span class="badge badge-red">✕ Rejected</span>'
      : '<span class="badge badge-amber">⏳ Pending</span>';

    const moveOpts = leagues.map(l =>
      `<option value="${esc(l.id)}">${esc(l.name)}${l.division ? ' · ' + esc(l.division) : ''}</option>`
    ).join('');

    body.innerHTML = entries.map(e => {
      const school = DB.getSchools().find(s => s.id === e.schoolId);
      const dot    = school ? `<span style="color:${school.color}">●</span> ` : '';
      return `<div class="entry-admin-row" data-entry-id="${esc(e.id)}">
        <div class="entry-admin-info">
          <div class="entry-admin-name">${dot}<strong>${esc(e.teamLabel || e.schoolId)}</strong> ${statusBadge(e.status)}</div>
          <div class="entry-admin-meta">
            Submitted by ${esc(e.enteredByName || e.enteredBy)} on ${formatDate(e.enteredAt.slice(0,10))}
            ${e.approvedByName ? `· ${e.status === 'approved' ? 'Approved' : 'Rejected'} by ${esc(e.approvedByName)}` : ''}
          </div>
        </div>
        <div class="entry-admin-actions">
          ${e.status !== 'approved' ? `<button class="btn btn-xs btn-primary entry-approve-btn">✅ Approve</button>` : ''}
          ${e.status !== 'rejected' ? `<button class="btn btn-xs btn-danger  entry-reject-btn">✕ Reject</button>` : ''}
          ${leagues.length > 0 && e.status !== 'rejected'
            ? `<select class="entry-move-sel" title="Move to another league">
                 <option value="">🔄 Move to…</option>${moveOpts}
               </select>`
            : ''}
        </div>
      </div>`;
    }).join('');

    // Wire approve
    body.querySelectorAll('.entry-approve-btn').forEach(btn => {
      const row = btn.closest('[data-entry-id]');
      btn.addEventListener('click', () => _approveEntry(row.dataset.entryId, leagueId));
    });
    // Wire reject
    body.querySelectorAll('.entry-reject-btn').forEach(btn => {
      const row = btn.closest('[data-entry-id]');
      btn.addEventListener('click', () => _rejectEntry(row.dataset.entryId, leagueId));
    });
    // Wire move
    body.querySelectorAll('.entry-move-sel').forEach(sel => {
      const row = sel.closest('[data-entry-id]');
      sel.addEventListener('change', () => {
        if (sel.value) _moveEntry(row.dataset.entryId, leagueId, sel.value);
      });
    });
  }

  async function _approveEntry(entryId, leagueId) {
    const entry  = DB.getLeagueEntries().find(e => e.id === entryId);
    const league = DB.getLeagues().find(l => l.id === leagueId);
    if (!entry || !league) return;
    const profile = Auth.getProfile();
    const updated = {
      ...entry,
      status:          'approved',
      approvedBy:      profile ? profile.uid : null,
      approvedByName:  profile ? (profile.displayName || profile.email) : null,
      approvedAt:      new Date().toISOString(),
    };
    DB.updateLeagueEntry(updated);
    DB.writeAudit('entry_approved', 'league', `Approved entry: ${entry.teamLabel} in ${league.name}`, entryId, entry.teamLabel);

    // ── Add school to league participants ──────────────────────────────────
    _addParticipantFromEntry(league, entry);

    // Notify the school
    await NotificationService.sendToSchool(entry.schoolId, {
      type:     'league_entry',
      title:    `League entry approved: ${league.name}`,
      body:     `Your entry for "${entry.teamLabel}" in ${league.name}${league.division ? ' · ' + league.division : ''} has been approved. Welcome to the league!`,
      leagueId: leagueId,
    });

    toast('Entry approved — school added to league ✓', 'success');
    _renderEntriesModal(leagueId);
    renderAdmin();
    render();
  }

  /**
   * Adds a school (from an entry) to a league's participants + schoolIds + standings.
   * Does NOT regenerate fixtures — master can do that via Edit League.
   */
  function _addParticipantFromEntry(league, entry) {
    const participants = _getParticipants(league).slice(); // copy
    const suffix       = entry.teamSuffix || '';
    const participantId = entry.schoolId + (suffix ? '_' + suffix : '');

    // Avoid duplicates
    if (participants.some(p => p.participantId === participantId)) return;

    participants.push({
      participantId,
      schoolId:   entry.schoolId,
      teamSuffix: suffix,
      teamName:   entry.teamName || '',
    });

    const schoolIds  = [...new Set(participants.map(p => p.schoolId))];
    const standings  = generateStandings(participants);

    // Merge new participants into existing standings without wiping played results
    const existingStandings = league.standings || [];
    const mergedStandings   = standings.map(row => {
      const ex = existingStandings.find(r => r.participantId === row.participantId);
      return ex || row;
    });

    const updatedLeague = { ...league, participants, schoolIds, standings: mergedStandings };
    DB.updateLeague(updatedLeague);
    DB.writeAudit('league_participant_added', 'league',
      `${entry.teamLabel} added to ${league.name} participants`, league.id, entry.teamLabel);
  }

  async function _rejectEntry(entryId, leagueId) {
    const entry  = DB.getLeagueEntries().find(e => e.id === entryId);
    const league = DB.getLeagues().find(l => l.id === leagueId);
    if (!entry || !league) return;
    const profile = Auth.getProfile();
    const updated = {
      ...entry,
      status:          'rejected',
      approvedBy:      profile ? profile.uid : null,
      approvedByName:  profile ? (profile.displayName || profile.email) : null,
      approvedAt:      new Date().toISOString(),
    };
    DB.updateLeagueEntry(updated);
    DB.writeAudit('entry_rejected', 'league', `Rejected entry: ${entry.teamLabel} in ${league.name}`, entryId, entry.teamLabel);

    // Notify the school
    await NotificationService.sendToSchool(entry.schoolId, {
      type:     'league_entry',
      title:    `League entry not accepted: ${league.name}`,
      body:     `Your entry for "${entry.teamLabel}" in ${league.name}${league.division ? ' · ' + league.division : ''} was not accepted. Please contact the league administrator for more information.`,
      leagueId: leagueId,
    });

    toast('Entry rejected', 'success');
    _renderEntriesModal(leagueId);
    renderAdmin();
  }

  async function _moveEntry(entryId, fromLeagueId, toLeagueId) {
    const entry     = DB.getLeagueEntries().find(e => e.id === entryId);
    const fromLeague = DB.getLeagues().find(l => l.id === fromLeagueId);
    const toLeague   = DB.getLeagues().find(l => l.id === toLeagueId);
    if (!entry || !fromLeague || !toLeague) return;
    const profile = Auth.getProfile();
    const updated = {
      ...entry,
      leagueId:         toLeagueId,
      status:           'approved',
      movedFromLeagueId: fromLeagueId,
      approvedBy:       profile ? profile.uid : null,
      approvedByName:   profile ? (profile.displayName || profile.email) : null,
      approvedAt:       new Date().toISOString(),
    };
    DB.updateLeagueEntry(updated);
    DB.writeAudit('entry_moved', 'league',
      `Moved entry ${entry.teamLabel} from ${fromLeague.name} to ${toLeague.name}`, entryId, entry.teamLabel);

    // Notify the school
    await NotificationService.sendToSchool(entry.schoolId, {
      type:     'league_entry',
      title:    `League entry moved: ${toLeague.name}`,
      body:     `Your entry for "${entry.teamLabel}" has been moved from ${fromLeague.name} to ${toLeague.name}${toLeague.division ? ' · ' + toLeague.division : ''}. Your entry is now approved in the new league.`,
      leagueId: toLeagueId,
    });

    toast(`Entry moved to ${toLeague.name} ✓`, 'success');
    Modal.close('leagueEntriesModal');
    renderAdmin();
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN OVERVIEW — pending entries list
  // ════════════════════════════════════════════════════════════

  function renderPendingEntries() {
    const el = document.getElementById('pendingEntriesList');
    if (!el) return;
    const pending = DB.getLeagueEntries().filter(e => e.status === 'pending');
    if (pending.length === 0) {
      el.innerHTML = `<p class="text-muted">No pending entries.</p>`;
      return;
    }
    el.innerHTML = pending.map(e => {
      const league = DB.getLeagues().find(l => l.id === e.leagueId);
      const school = DB.getSchools().find(s => s.id === e.schoolId);
      const dot    = school ? `<span style="color:${school.color}">●</span> ` : '';
      return `<div class="admin-list-item" style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap">
        <div>
          <div>${dot}<strong>${esc(e.teamLabel || e.schoolId)}</strong>
            <span class="badge badge-amber" style="font-size:.72rem;margin-left:.3rem">pending</span>
          </div>
          <div class="text-muted" style="font-size:.82rem">${esc(league ? league.name : e.leagueId)}${league && league.division ? ' · ' + esc(league.division) : ''} · submitted ${_relativeEntryTime(e.enteredAt)}</div>
        </div>
        <div style="display:flex;gap:.3rem;flex-wrap:wrap">
          <button class="btn btn-xs btn-primary"   data-quick-approve="${esc(e.id)}" data-quick-league="${esc(e.leagueId)}">✅ Approve</button>
          <button class="btn btn-xs btn-danger"    data-quick-reject="${esc(e.id)}"  data-quick-league="${esc(e.leagueId)}">✕ Reject</button>
          <button class="btn btn-xs btn-secondary" data-overview-entries="${esc(e.leagueId)}">Details</button>
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('[data-quick-approve]').forEach(btn => {
      btn.addEventListener('click', () => {
        _approveEntry(btn.dataset.quickApprove, btn.dataset.quickLeague);
        renderPendingEntries();
      });
    });
    el.querySelectorAll('[data-quick-reject]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Reject this entry?')) return;
        _rejectEntry(btn.dataset.quickReject, btn.dataset.quickLeague);
        renderPendingEntries();
      });
    });
    el.querySelectorAll('[data-overview-entries]').forEach(btn => {
      btn.addEventListener('click', () => openEntriesModal(btn.dataset.overviewEntries));
    });
  }

  function _renderExcludedDateTags() {
    const list = document.getElementById('leagueExcludedDatesList');
    if (!list) return;
    if (_excludedDates.length === 0) {
      list.innerHTML = '<span style="color:var(--text-muted,#6b7280);font-size:.85rem">No excluded dates</span>';
      return;
    }
    list.innerHTML = _excludedDates.map(d =>
      `<span class="badge badge-amber" style="display:inline-flex;align-items:center;gap:.25rem">${esc(formatDate(d))}<button type="button" data-remove-date="${esc(d)}" style="background:none;border:none;cursor:pointer;font-weight:bold;padding:0 0 0 .1rem;font-size:1rem;line-height:1;color:inherit">&times;</button></span>`
    ).join('');
    list.querySelectorAll('[data-remove-date]').forEach(btn => {
      btn.addEventListener('click', () => {
        _excludedDates = _excludedDates.filter(d => d !== btn.dataset.removeDate);
        _renderExcludedDateTags();
      });
    });
  }

  function _relativeEntryTime(iso) {
    if (!iso) return '';
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  }

  // ════════════════════════════════════════════════════════════
  // LEAGUE MODAL (create / edit)
  // ════════════════════════════════════════════════════════════
  function openLeagueModal(id) {
    const schools = DB.getSchools();
    const venues  = DB.getVenues();
    const l       = id ? DB.getLeagues().find(x => x.id === id) : null;

    document.getElementById('leagueModalTitle').textContent  = l ? 'Edit League' : 'Add League';
    document.getElementById('leagueName').value              = l ? l.name : '';
    document.getElementById('leagueDivision').value          = l ? (l.division   || '') : '';
    document.getElementById('leagueStart').value             = l ? (l.startDate  || '') : '';
    document.getElementById('leagueEnd').value               = l ? (l.endDate    || '') : '';
    document.getElementById('leagueHomeMatches').value       = l ? (l.homeMatches >= 1 ? 1 : 0) : 1;
    document.getElementById('leaguePlayingDay').value        = l !== null ? (l.playingDay !== undefined ? l.playingDay : 5) : 5;
    document.getElementById('leagueMatchTime').value         = l ? (l.matchTime      || '14:00') : '14:00';
    document.getElementById('leagueEntryDeadline').value    = l ? (l.entryDeadline  || '')      : '';
    document.getElementById('leagueScoreTotal').value        = l ? (l.scoreTotal     || 67)      : 67;
    document.getElementById('leagueEditId').value            = l ? l.id : '';

    // Excluded dates
    _excludedDates = l ? [...(l.excludedDates || [])] : [];
    _renderExcludedDateTags();

    // League name+division uniqueness warning
    const _checkNameWarning = () => {
      const name = document.getElementById('leagueName').value.trim();
      const div  = document.getElementById('leagueDivision').value.trim();
      const editId = document.getElementById('leagueEditId').value;
      const warn = document.getElementById('leagueNameWarning');
      if (!warn) return;
      const conflict = DB.getLeagues().find(x =>
        x.id !== editId &&
        x.name.toLowerCase() === name.toLowerCase() &&
        (x.division || '').toLowerCase() === div.toLowerCase()
      );
      if (conflict) {
        warn.style.display = '';
        warn.textContent = `⚠️ Another league with the name "${name}" in division "${div || '(none)'}" already exists. Consider making the name unique (e.g. include the division abbreviation).`;
      } else {
        warn.style.display = 'none';
        warn.textContent = '';
      }
    };
    ['leagueName', 'leagueDivision'].forEach(id => {
      const el2 = document.getElementById(id);
      if (el2 && !el2.dataset.warnBound) {
        el2.addEventListener('input', _checkNameWarning);
        el2.dataset.warnBound = '1';
      }
    });
    _checkNameWarning();

    const neutralSel = document.getElementById('leagueNeutralVenue');
    neutralSel.innerHTML = `<option value="">None</option>` +
      venues.map(v => `<option value="${v.id}"${l && l.neutralVenueId === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('');

    // Build map of existing participants: schoolId → team count (for editing)
    const existingMap = new Map(); // schoolId → count
    if (l) {
      _getParticipants(l).forEach(p => {
        existingMap.set(p.schoolId, (existingMap.get(p.schoolId) || 0) + 1);
      });
    }

    const sortedSchools = [...schools].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Build a map of pending/approved entries for this league (if editing)
    const entryMap = new Map(); // schoolId → { count, labels[] }
    if (l) {
      DB.getEntriesForLeague(l.id).forEach(e => {
        if (e.status === 'rejected') return;
        if (!entryMap.has(e.schoolId)) entryMap.set(e.schoolId, { count: 0, labels: [], statuses: [] });
        const rec = entryMap.get(e.schoolId);
        rec.count++;
        rec.labels.push(e.teamLabel || e.teamName || '');
        rec.statuses.push(e.status);
      });
    }

    const box = document.getElementById('leagueSchoolsCheckboxes');
    box.classList.add('checkbox-grid--teams');
    box.innerHTML = sortedSchools.map(s => {
      const count     = existingMap.get(s.id) || 0;
      const isChecked = count > 0;
      const teams     = count > 0 ? count : 1;

      // Entry indicator — show pending/approved entries from the entries system
      const entryRec = entryMap.get(s.id);
      let entryTag = '';
      if (entryRec) {
        const hasApproved = entryRec.statuses.some(st => st === 'approved');
        const hasPending  = entryRec.statuses.some(st => st === 'pending');
        const tagClass    = hasApproved ? 'entry-tag--approved' : 'entry-tag--pending';
        const tagIcon     = hasApproved ? '✓' : '⏳';
        const tip         = entryRec.labels.join(', ');
        entryTag = `<span class="entry-tag ${tagClass}" title="${esc(tip)}">${tagIcon} ${entryRec.count === 1 ? '1 entry' : entryRec.count + ' entries'}</span>`;
      }

      return `<label class="school-select-row${entryRec ? ' school-has-entry' : ''}">
        <span class="school-check-area">
          <input type="checkbox" class="school-cb" value="${s.id}" ${isChecked ? 'checked' : ''}>
          <span style="color:${s.color}">●</span> ${esc(s.name)}${s.team ? ` <em style="color:var(--neutral);font-size:.8em">(${esc(s.team)})</em>` : ''}
          ${entryTag}
        </span>
        <span class="team-stepper"${isChecked ? '' : ' style="display:none"'}>
          <button type="button" class="stepper-btn stepper-dec" title="Remove team">−</button>
          <span class="team-count-val">${teams}</span>
          <button type="button" class="stepper-btn stepper-inc" title="Add 2nd team">+</button>
          <span class="stepper-label">${teams > 1 ? 'teams' : 'team'}</span>
        </span>
      </label>`;
    }).join('');

    // Show / hide stepper when checkbox toggled
    box.querySelectorAll('.school-cb').forEach(cb => {
      const stepper = cb.closest('.school-select-row').querySelector('.team-stepper');
      cb.addEventListener('change', () => {
        stepper.style.display = cb.checked ? '' : 'none';
        if (cb.checked) {
          stepper.querySelector('.team-count-val').textContent = '1';
          stepper.querySelector('.stepper-label').textContent  = 'team';
        }
      });
    });

    // Decrement — goes from 2→1, then 1 unchecks the school
    box.querySelectorAll('.stepper-dec').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const row     = btn.closest('.school-select-row');
        const valSpan = row.querySelector('.team-count-val');
        const lbl     = row.querySelector('.stepper-label');
        const val     = parseInt(valSpan.textContent);
        if (val > 1) {
          valSpan.textContent = val - 1;
          lbl.textContent = 'team';
        } else {
          row.querySelector('.school-cb').checked = false;
          row.querySelector('.team-stepper').style.display = 'none';
        }
      });
    });

    // Increment — max 2 teams per school per league
    box.querySelectorAll('.stepper-inc').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const row     = btn.closest('.school-select-row');
        const valSpan = row.querySelector('.team-count-val');
        const lbl     = row.querySelector('.stepper-label');
        const val     = parseInt(valSpan.textContent);
        if (val < 2) {
          valSpan.textContent = val + 1;
          lbl.textContent = 'teams';
        }
      });
    });

    Modal.open('leagueModal');
  }

  function saveLeague(detailsOnly = false) {
    const name = document.getElementById('leagueName').value.trim();
    if (!name) { toast('League name required', 'error'); return; }

    const id             = document.getElementById('leagueEditId').value;
    const entryDeadline  = document.getElementById('leagueEntryDeadline').value || null;
    const startDate      = document.getElementById('leagueStart').value;
    const endDate        = document.getElementById('leagueEnd').value;
    const homeMatches    = parseInt(document.getElementById('leagueHomeMatches').value); // 0 = meet once, 1 = home&away (no || fallback — 0 is valid)
    const neutralVenueId = document.getElementById('leagueNeutralVenue').value || null;
    const playingDay     = parseInt(document.getElementById('leaguePlayingDay').value);
    const matchTime      = document.getElementById('leagueMatchTime').value || '14:00';
    const division       = document.getElementById('leagueDivision').value.trim();
    const scoreTotal     = parseInt(document.getElementById('leagueScoreTotal')?.value) || 67;
    const excludedDates  = [..._excludedDates];

    // ── Details-only save (updates settings + participants, no fixture regen) ──
    if (detailsOnly) {
      if (!id) { toast('Save the league first before using Save Details', 'error'); return; }
      const existing = DB.getLeagues().find(l => l.id === id);
      if (!existing) { toast('League not found', 'error'); return; }

      // Read checked schools — same logic as full save
      const box = document.getElementById('leagueSchoolsCheckboxes');
      const newParticipants = [];
      box.querySelectorAll('.school-cb:checked').forEach(cb => {
        const schoolId  = cb.value;
        const countSpan = cb.closest('.school-select-row').querySelector('.team-count-val');
        const count     = countSpan ? parseInt(countSpan.textContent) : 1;
        if (count === 1) {
          newParticipants.push({ participantId: schoolId, schoolId, teamSuffix: '' });
        } else {
          newParticipants.push({ participantId: schoolId + '_A', schoolId, teamSuffix: 'A' });
          newParticipants.push({ participantId: schoolId + '_B', schoolId, teamSuffix: 'B' });
        }
      });

      const newSchoolIds = [...new Set(newParticipants.map(p => p.schoolId))];

      // Merge standings: keep existing rows, add rows for any new participants
      const existingStandings = existing.standings || [];
      const mergedStandings = newParticipants.map(p => {
        return existingStandings.find(r => r.participantId === p.participantId)
          || generateStandings([p])[0];
      });

      const updated = {
        ...existing,
        name, division, startDate, endDate, entryDeadline,
        homeMatches, neutralVenueId, playingDay, matchTime, scoreTotal,
        excludedDates: [..._excludedDates],
        participants: newParticipants,
        schoolIds:    newSchoolIds,
        standings:    mergedStandings,
      };
      DB.updateLeague(updated)
        .then(() => {
          DB.writeAudit('league_updated', 'league', `Updated league details: ${name}`, id, name);
          _autoApproveEntriesForParticipants(updated);
          toast('League details saved ✓', 'success');
          Modal.close('leagueModal');
          render();
          renderAdmin();
        })
        .catch(err => {
          console.error('[Leagues] updateLeague (details) failed:', err);
          toast('Failed to save league — ' + (err.message || err), 'error');
        });
      return;
    }

    // ── Full save with fixture generation ────────────────────────
    const box          = document.getElementById('leagueSchoolsCheckboxes');
    const participants = [];
    box.querySelectorAll('.school-cb:checked').forEach(cb => {
      const schoolId  = cb.value;
      const countSpan = cb.closest('.school-select-row').querySelector('.team-count-val');
      const count     = countSpan ? parseInt(countSpan.textContent) : 1;
      if (count === 1) {
        participants.push({ participantId: schoolId, schoolId, teamSuffix: '' });
      } else {
        participants.push({ participantId: schoolId + '_A', schoolId, teamSuffix: 'A' });
        participants.push({ participantId: schoolId + '_B', schoolId, teamSuffix: 'B' });
      }
    });

    if (participants.length < 2) { toast('At least 2 teams required to generate fixtures', 'error'); return; }

    const schoolIds = [...new Set(participants.map(p => p.schoolId))];

    let generatedFixtures;
    try {
      generatedFixtures = generateFixtures(participants, homeMatches, startDate, neutralVenueId, playingDay, matchTime, id || null, endDate, excludedDates);
    } catch (err) {
      console.error('generateFixtures error:', err);
      toast('Error generating fixtures: ' + err.message, 'error');
      return;
    }

    const league = {
      id: id || uid(),
      name,
      division,
      startDate,
      endDate,
      entryDeadline,
      excludedDates,
      schoolIds,
      participants,
      homeMatches,
      neutralVenueId,
      playingDay,
      matchTime,
      scoreTotal,
      fixtures:  generatedFixtures,
      standings: generateStandings(participants),
    };

    if (id) {
      DB.updateLeague(league)
        .then(() => {
          DB.writeAudit('league_updated', 'league', `Updated league: ${name}`, league.id, name);
          _autoApproveEntriesForParticipants(league);
          toast('League updated ✓', 'success');
        })
        .catch(err => {
          console.error('[Leagues] updateLeague failed:', err);
          toast('Failed to save league — ' + (err.message || err), 'error');
        });
    } else {
      DB.addLeague(league)
        .then(() => {
          DB.writeAudit('league_created', 'league', `Created league: ${name} (${league.fixtures.length} fixtures)`, league.id, name);
          toast(`League created — ${league.fixtures.length} fixtures generated ✓`, 'success');
          if (typeof NotificationService !== 'undefined') {
            NotificationService.sendToLeagueParticipants(league.id, {
              type:     'league_created',
              title:    `New league: ${name}`,
              body:     `${name}${division ? ' · ' + division : ''} has been created. Your fixtures start ${startDate ? formatDate(startDate) : 'soon'}.`,
              leagueId: league.id,
            });
          }
        })
        .catch(err => {
          console.error('[Leagues] addLeague failed:', err);
          toast('Failed to save league — ' + (err.message || err), 'error');
        });
    }

    Modal.close('leagueModal');
    render();
    renderAdmin();
    Calendar.refresh();
  }

  /**
   * After a full save, auto-approve any pending leagueEntries whose schoolId
   * is now in the league's participants, and notify the school.
   */
  async function _autoApproveEntriesForParticipants(league) {
    const profile      = Auth.getProfile();
    const approverName = profile ? (profile.displayName || profile.email) : 'Admin';
    const approverUid  = profile ? profile.uid : null;
    const participantSchoolIds = new Set(league.participants.map(p => p.schoolId));

    const pending = DB.getEntriesForLeague(league.id).filter(
      e => e.status === 'pending' && participantSchoolIds.has(e.schoolId)
    );
    for (const entry of pending) {
      const updated = {
        ...entry,
        status:         'approved',
        approvedBy:     approverUid,
        approvedByName: approverName,
        approvedAt:     new Date().toISOString(),
      };
      DB.updateLeagueEntry(updated);
      DB.writeAudit('entry_approved', 'league',
        `Auto-approved entry: ${entry.teamLabel} in ${league.name}`, entry.id, entry.teamLabel);

      if (typeof NotificationService !== 'undefined') {
        await NotificationService.sendToSchool(entry.schoolId, {
          type:     'league_entry',
          title:    `League entry approved: ${league.name}`,
          body:     `Your entry for "${entry.teamLabel}" in ${league.name}${league.division ? ' · ' + league.division : ''} has been approved. Welcome to the league!`,
          leagueId: league.id,
        });
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // FIXTURE GENERATION — round-robin with playing day scheduling
  // ════════════════════════════════════════════════════════════

  /**
   * Generate round-robin fixtures with clash-aware date/court scheduling.
   *
   * @param {Array}  participants        [{participantId, schoolId, teamSuffix}]
   * @param {number} homeMatchesPerPair  home legs per pair (1 = single RR, 2 = double)
   * @param {string} startDateStr        YYYY-MM-DD start date
   * @param {string} neutralVenueId      fallback venue when home team has none
   * @param {number} playingDay          0=Sun … 6=Sat
   * @param {string} matchTime           HH:MM match start time
   * @param {string} [leagueId]          ID of the league being (re)generated
   * @param {string} [endDateStr]        YYYY-MM-DD hard cap — no fixture beyond this date
   */
  function generateFixtures(participants, homeMatchesPerPair, startDateStr, neutralVenueId, playingDay, matchTime, leagueId, endDateStr, excludedDates) {
    if (!participants || participants.length < 2) return [];

    const COURTS_PER_MATCH = 3;
    const MATCH_MINS       = 180;
    const fixStart = timeToMins(matchTime || '14:00');
    const fixEnd   = fixStart + MATCH_MINS;

    // ── Resolve participants to team objects ─────────────────────
    const teams = participants.map(p => {
      const school = DB.getSchools().find(s => s.id === p.schoolId);
      if (!school) return null;
      return {
        participantId: p.participantId,
        schoolId:      p.schoolId,
        teamSuffix:    p.teamSuffix,
        name:          school.name + (p.teamSuffix ? ' ' + p.teamSuffix : ''),
        venueId:       school.venueId || null,
        color:         school.color,
      };
    }).filter(Boolean);

    // Randomise team order so the draw is not biased by registration order.
    // A school registered first (e.g. AHMP) would otherwise always draw
    // a first-round home game — the shuffle distributes this fairly.
    for (let i = teams.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [teams[i], teams[j]] = [teams[j], teams[i]];
    }

    // Stamp each team with its stable position so the H/A index formula
    // works via direct property access — no indexOf or Map lookup needed.
    teams.forEach((t, i) => { t._balanceIdx = i; });

    if (teams.length < 2) return [];

    // ── Same-school double-team venues ───────────────────────────
    // Identify venues where ONE school has 2+ teams in this league.
    // Those venues are allowed to host both home games on the same day
    // ONLY if the venue has at least 4 courts; otherwise the second
    // home game must be pushed to a different week.
    const _schoolVenueCount = {};
    teams.forEach(t => {
      if (!t.venueId) return;
      const key = `${t.schoolId}|${t.venueId}`;
      _schoolVenueCount[key] = (_schoolVenueCount[key] || 0) + 1;
    });
    const sameSchoolVenues = new Set(
      Object.keys(_schoolVenueCount)
        .filter(k => _schoolVenueCount[k] > 1)
        .map(k => k.split('|')[1])
    );

    const targetDay = (playingDay !== undefined && playingDay !== null) ? parseInt(playingDay) : 5;

    // ── Berger (circle) round-robin pairings ─────────────────────
    const pool = [...teams];
    if (pool.length % 2 === 1) pool.push(null);          // bye for odd count
    const numTeams  = pool.length;
    const numRounds = numTeams - 1;

    const singleRRRounds = [];
    const circle = [...pool];
    for (let r = 0; r < numRounds; r++) {
      const matches = [];
      for (let i = 0; i < numTeams / 2; i++) {
        const home = circle[i];
        const away = circle[numTeams - 1 - i];
        if (home && away) matches.push({ home, away });
      }
      singleRRRounds.push(matches);
      const last = circle.splice(numTeams - 1, 1)[0];
      circle.splice(1, 0, last);
    }

    // Build the full round list based on format:
    //   0 = "Only meet once"  → single round-robin with index-formula H/A assignment
    //   1 = "Home & Away"     → each pair plays home + away (inherently balanced)
    const allRounds = [];
    if (homeMatchesPerPair === 0) {
      // Each pair meets exactly once.
      // Use an index-based formula for home/away assignment that is provably optimal:
      //   For pair (i, j) with i < j (0-based position in the teams array):
      //     home = team[i]  if (j - i) is ODD
      //     home = team[j]  if (j - i) is EVEN
      // This guarantees each team's |home − away| ≤ 1, which is the best
      // achievable when each team plays an odd number of games (N−1 for even N).
      // Use the _balanceIdx stamp assigned at team creation — O(1), no lookup
      // needed, works even if object references are ever copied or wrapped.
      singleRRRounds.forEach(round => {
        const balancedRound = round.map(m => {
          const iA = m.home._balanceIdx;
          const iB = m.away._balanceIdx;
          const lo = Math.min(iA, iB);
          const hi = Math.max(iA, iB);
          // Odd gap → lower-indexed team is home; even gap → higher-indexed is home
          const loIsHome = (hi - lo) % 2 === 1;
          const homeTeam = loIsHome
            ? (iA === lo ? m.home : m.away)
            : (iA === hi ? m.home : m.away);
          const awayTeam = homeTeam === m.home ? m.away : m.home;
          return { home: homeTeam, away: awayTeam };
        });
        allRounds.push(balancedRound);
      });
    } else {
      // Home & Away: push each round followed immediately by its mirror.
      // Every team ends up with exactly (N-1) home and (N-1) away games.
      const reps = Math.max(1, homeMatchesPerPair);
      for (let rep = 0; rep < reps; rep++) {
        singleRRRounds.forEach(round => {
          allRounds.push(round);
          allRounds.push(round.map(m => ({ home: m.away, away: m.home })));
        });
      }
    }

    // First playing day on or after startDate
    let baseDate = startDateStr ? parseDate(startDateStr) : new Date();
    const daysAhead = (targetDay - baseDate.getDay() + 7) % 7;
    baseDate = addDays(baseDate, daysAhead);

    // Hard end-date cap (null = no cap)
    const endDateObj = endDateStr ? parseDate(endDateStr) : null;

    // Build list of valid playing dates: weekly from baseDate, skipping excluded dates
    // and dates where any home venue in the round has a full-venue full-day closure.
    const excludedSet = new Set(excludedDates || []);

    /** True if ANY venue used as a home ground (or the neutral venue) in this round
     *  has an all-day, all-court closure covering dateStr. */
    function _roundVenueClosed(round, dateStr) {
      const venueIds = new Set();
      round.forEach(m => {
        const vid = m.home.venueId || neutralVenueId;
        if (vid) venueIds.add(vid);
      });
      const closures = DB.getClosures();
      for (const venueId of venueIds) {
        const closed = closures.some(c => {
          if (c.venueId !== venueId) return false;
          if (dateStr < c.startDate || dateStr > c.endDate) return false;
          // Only whole-venue closures (courtIndex null/'') — court-specific may still leave room
          if (c.courtIndex !== null && c.courtIndex !== undefined && c.courtIndex !== '') return false;
          // Only full-day closures — time-specific closures don't block the whole day
          if (c.timeStart && c.timeEnd) return false;
          return true;
        });
        if (closed) return true;
      }
      return false;
    }

    const validPlayingDates = [];
    let _cd = new Date(baseDate);
    for (let _i = 0; validPlayingDates.length < allRounds.length && _i < allRounds.length + 200; _i++) {
      const roundIdx = validPlayingDates.length;
      const ds = toDateStr(_cd);
      if (!excludedSet.has(ds) && !_roundVenueClosed(allRounds[roundIdx], ds)) {
        validPlayingDates.push(ds);
      }
      _cd = addDays(_cd, 7);
    }
    // Safety fallback (more excluded/closed dates than buffer allows)
    while (validPlayingDates.length < allRounds.length) {
      validPlayingDates.push(toDateStr(_cd));
      _cd = addDays(_cd, 7);
    }

    // ── Venue slot tracker ───────────────────────────────────────
    // venueUsage[venueId][date] = [ courtStart, … ] of already-claimed blocks
    const venueUsage = {};

    function _claim(venueId, date, courtStart) {
      if (!venueUsage[venueId])        venueUsage[venueId] = {};
      if (!venueUsage[venueId][date])  venueUsage[venueId][date] = [];
      venueUsage[venueId][date].push(courtStart);
    }

    // Returns array of courtStart values already booked at (venueId, date)
    // overlapping the fixture time window.  For same-league fixtures every
    // fixture uses the same matchTime so all overlap → just count all.
    // For cross-league we check the stored time window.
    function _takenCourts(venueId, date) {
      return (venueUsage[venueId] || {})[date] || [];
    }

    // Pre-populate from OTHER leagues (cross-league clash awareness)
    DB.getLeagues().forEach(l => {
      if (l.id === leagueId) return;   // skip self (we're replacing these)
      (l.fixtures || []).forEach(f => {
        if (!f.venueId || !f.date) return;
        const otherStart = timeToMins(f.timeSlot || '14:00');
        const otherEnd   = otherStart + MATCH_MINS;
        // Only count if the time windows actually overlap
        if (otherStart < fixEnd && otherEnd > fixStart) {
          _claim(f.venueId, f.date, f.courtIndex || 0);
        }
      });
    });

    // ── Assign dates + courts greedily ───────────────────────────
    const fixtures = [];

    allRounds.forEach((round, roundIdx) => {
      round.forEach(match => {
        const homeVenue = match.home.venueId
          ? DB.getVenues().find(v => v.id === match.home.venueId)
          : null;
        const hasHome   = homeVenue && (homeVenue.courts || 0) > 0;
        const venueId   = hasHome ? homeVenue.id : (neutralVenueId || null);
        const venue     = venueId ? DB.getVenues().find(v => v.id === venueId) : null;
        const venueName   = venue ? venue.name : 'TBA';
        const venueCourts = venue ? (venue.courts || 0) : 0;
        // Capacity planning uses 2 courts as the minimum unit so venues like
        // Midstream (4 courts) can host 2 fixtures (not just 1).
        // Actual courtsBooked is set in the post-processing pass below.
        const baseSlots = venueCourts > 0
          ? Math.max(Math.floor(venueCourts / 2), 1)
          : 0;

        // If this venue hosts two teams from the same school, allow both home
        // games on the same day only when the venue has ≥ 4 courts.
        // (With < 4 courts the second home game is pushed to the next week.)
        const effectiveMaxSlots = sameSchoolVenues.has(venueId) && venueCourts >= 4
          ? Math.max(baseSlots, 2)
          : baseSlots;

        // All fixtures in a round share the same date — never push to another week.
        // Venue clashes within a round are flagged for the master to resolve.
        const roundDate   = validPlayingDates[roundIdx] || toDateStr(addDays(baseDate, roundIdx * 7));
        let assignedDate  = roundDate;
        let assignedCourt = 0;

        if (venueId && effectiveMaxSlots > 0) {
          const taken = _takenCourts(venueId, roundDate);
          if (taken.length < effectiveMaxSlots) {
            // Free court slot available — claim it (step by 2, post-proc redistributes)
            let court = 0;
            while (taken.includes(court)) court += 2;
            assignedCourt = court;
            _claim(venueId, roundDate, court);
          } else {
            // Venue full on this date — schedule anyway and flag as clash
            assignedCourt = effectiveMaxSlots * 2;
            _claim(venueId, roundDate, assignedCourt);
          }
        }

        fixtures.push({
          id:                uid(),
          homeParticipantId: match.home.participantId,
          awayParticipantId: match.away.participantId,
          homeSchoolId:      match.home.schoolId,
          homeSchoolName:    match.home.name,
          awaySchoolId:      match.away.schoolId,
          awaySchoolName:    match.away.name,
          venueId,
          venueName,
          isNeutral:    !hasHome,
          date:         assignedDate,
          timeSlot:     matchTime || '14:00',
          courtIndex:   assignedCourt,
          courtsBooked: COURTS_PER_MATCH,   // overwritten by _redistributeCourts below
          homeScore:    null,
          awayScore:    null,
          round:        roundIdx + 1,
        });
      });
    });

    // ── Post-processing: redistribute court blocks ───────────────
    // Groups fixtures by venue+date and divides courts evenly (max 3 each).
    // e.g. 4-court venue with 2 fixtures → 2 courts each (Courts 1–2 and 3–4).
    //      6-court venue with 3 fixtures → 2 courts each.
    //      6-court venue with 2 fixtures → 3 courts each.
    //      1-court venue → courtsBooked=1 (flagged as clash by detectFixtureClashes).
    function _redistributeCourts(fixArr) {
      const groups = {};
      fixArr.forEach((f, i) => {
        if (!f.venueId || !f.date) return;
        const k = `${f.venueId}|${f.date}`;
        (groups[k] || (groups[k] = [])).push(i);
      });
      Object.values(groups).forEach(idxList => {
        const f0    = fixArr[idxList[0]];
        const ven   = DB.getVenues().find(v => v.id === f0.venueId);
        const vc    = ven ? (ven.courts || 0) : 0;
        const n     = idxList.length;
        const cb    = Math.min(3, Math.max(1, Math.floor(vc / n)));
        idxList.forEach((fi, i) => {
          fixArr[fi].courtsBooked = cb;
          fixArr[fi].courtIndex   = i * cb;
        });
      });
    }
    _redistributeCourts(fixtures);

    // H/A balance is the priority — clashes are shown as-is for the
    // master to resolve manually rather than auto-swapping home/away.

    return fixtures;
  }

  function generateStandings(participants) {
    return participants.map(p => ({
      participantId: p.participantId,
      schoolId:      p.schoolId,
      name:          _participantName(p),
      played: 0, won: 0, lost: 0, drawn: 0, points: 0,
    }));
  }

  function recalcStandings(league) {
    const parts = _getParticipants(league);

    const standings = {};
    parts.forEach(p => {
      standings[p.participantId] = {
        participantId: p.participantId,
        schoolId:      p.schoolId,
        name:          _participantName(p),
        played: 0, won: 0, lost: 0, drawn: 0, points: 0,
      };
    });

    (league.fixtures || []).forEach(f => {
      if (f.homeScore === null || f.homeScore === undefined) return;
      const h       = f.homeScore, a = f.awayScore;
      // Use participantId if present, fall back to schoolId (old fixtures)
      const homeKey = f.homeParticipantId || f.homeSchoolId;
      const awayKey = f.awayParticipantId || f.awaySchoolId;
      if (!standings[homeKey] || !standings[awayKey]) return;

      standings[homeKey].played++;
      standings[awayKey].played++;
      if (h > a) {
        standings[homeKey].won++;  standings[homeKey].points += 3;
        standings[awayKey].lost++;
      } else if (a > h) {
        standings[awayKey].won++;  standings[awayKey].points += 3;
        standings[homeKey].lost++;
      } else {
        standings[homeKey].drawn++; standings[homeKey].points++;
        standings[awayKey].drawn++; standings[awayKey].points++;
      }
    });

    league.standings = Object.values(standings).sort((a, b) => b.points - a.points || b.won - a.won);
    return league;
  }

  // ════════════════════════════════════════════════════════════
  // LEAGUE DETAIL MODAL  (fixtures + standings)
  // ════════════════════════════════════════════════════════════
  // ── Score verification helpers ───────────────────────────
  function _isVerified(f) {
    return !!(f.masterVerified || (f.homeTeamVerified && f.awayTeamVerified));
  }

  /** HTML badge showing verification state. */
  function _verifyBadge(f, leagueId) {
    if (f.homeScore === null || f.homeScore === undefined) return '';
    if (_isVerified(f)) return `<div class="score-verified">✓ Verified</div>`;

    const profile     = Auth.getProfile();
    const mySchoolId  = profile ? profile.schoolId : null;
    const isHomeUser  = mySchoolId === f.homeSchoolId;
    const isAwayUser  = mySchoolId === f.awaySchoolId;

    let status = '';
    if (f.homeTeamVerified)  status = '⏳ Awaiting away team';
    else if (f.awayTeamVerified) status = '⏳ Awaiting home team';
    else status = '⚠️ Unverified';

    let btn = '';
    if (!f.awayTeamVerified && isAwayUser) {
      btn = `<button class="btn btn-xs btn-primary verify-btn" data-lid="${leagueId}" data-fid="${f.id}" data-as="away">Verify ✓</button>`;
    } else if (!f.homeTeamVerified && isHomeUser) {
      btn = `<button class="btn btn-xs btn-primary verify-btn" data-lid="${leagueId}" data-fid="${f.id}" data-as="home">Verify ✓</button>`;
    }
    if (Auth.isAdmin()) {
      btn += `<button class="btn btn-xs btn-secondary verify-btn" data-lid="${leagueId}" data-fid="${f.id}" data-as="master" title="Master verify on behalf of both teams">Master ✓</button>`;
    }
    return `<div class="score-unverified"><span class="score-unverified-badge">${status}</span>${btn}</div>`;
  }

  /** Clash badge for a fixture. */
  function _clashBadge(f, leagueId, clashedIds) {
    if (!clashedIds.has(f.id)) return '';
    if (f.clashOkayed) {
      return `<div class="clash-okayed-badge" title="Reason: ${esc(f.clashReason || '')}">✓ Clash okayed${f.clashReason ? ': ' + esc(f.clashReason) : ''}</div>`;
    }
    const okayBtn = Auth.isAdmin()
      ? `<button class="btn btn-xs btn-warning okay-clash-btn" data-lid="${leagueId}" data-fid="${f.id}">Okay Clash</button>`
      : '';
    return `<div class="fixture-clash-badge">⚠️ Potential venue clash ${okayBtn}</div>`;
  }

  /** Change-request badge shown in admin fixtures tab. */
  function _changeRequestBadge(f, leagueId) {
    if (!f.changeRequest) return '';
    const cr = f.changeRequest;
    const vName = cr.requestedVenueId ? (DB.getVenues().find(v => v.id === cr.requestedVenueId) || {}).name : null;
    const detail = cr.type === 'venue'
      ? `Alt. venue: ${vName || cr.requestedVenueId}`
      : `Reschedule: ${cr.requestedDate || '?'} ${cr.requestedTime || ''}`;
    return `<div class="change-request-badge">
      📨 ${esc(cr.requestedByName || 'School')}: ${detail}
      ${cr.note ? `<em style="color:var(--neutral)"> — ${esc(cr.note)}</em>` : ''}
      ${Auth.isAdmin() ? `
        <button class="btn btn-xs btn-primary apply-cr-btn" data-lid="${leagueId}" data-fid="${f.id}">Apply</button>
        <button class="btn btn-xs btn-danger  reject-cr-btn" data-lid="${leagueId}" data-fid="${f.id}">Dismiss</button>` : ''}
    </div>`;
  }

  function openLeagueDetail(id, isAdmin = false, recalc = true, highlightFixtureId = null) {
    const league = DB.getLeagues().find(l => l.id === id);
    if (!league) return;
    const schools = DB.getSchools();

    // Track which detail is open so refresh() can live-update it
    _currentDetailId      = id;
    _currentDetailIsAdmin = isAdmin;

    document.getElementById('leagueDetailTitle').textContent = league.name;
    const body = document.getElementById('leagueDetailBody');

    // Only recalc+persist when opened by user action (recalc=true).
    // Skip when called from refresh() to avoid an onSnapshot write-loop.
    if (recalc) {
      recalcStandings(league);
      DB.updateLeague(league);
    }

    body.innerHTML = `
      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="fixtures">Fixtures</button>
        <button class="modal-tab" data-tab="standings">Standings</button>
        <button class="modal-tab" data-tab="balance">H/A Balance</button>
      </div>
      <div id="tab-fixtures">${_fixturesTab(league, schools, isAdmin)}</div>
      <div id="tab-standings" class="hidden">${_standingsTab(league, schools)}</div>
      <div id="tab-balance"   class="hidden">${_balanceTab(league)}</div>
    `;

    body.querySelectorAll('.modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        body.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        body.querySelectorAll('[id^="tab-"]').forEach(p => p.classList.add('hidden'));
        document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
      });
    });

    // Score editing — any logged-in user
    if (Auth.isLoggedIn()) {
      const SCORE_TOTAL = league.scoreTotal || 67;
      body.querySelectorAll('.score-input').forEach(inp => {
        inp.addEventListener('input', () => {
          const val = parseInt(inp.value);
          if (isNaN(val) || val < 0) return;
          const partnerField = inp.dataset.field === 'homeScore' ? 'awayScore' : 'homeScore';
          const partner = body.querySelector(
            `.score-input[data-fixture="${inp.dataset.fixture}"][data-field="${partnerField}"]`
          );
          if (!partner) return;
          const prevAuto = parseInt(partner.dataset.autoVal);
          const partnerVal = parseInt(partner.value);
          if (partner.value === '' || (!isNaN(prevAuto) && partnerVal === prevAuto)) {
            const auto = SCORE_TOTAL - val;
            if (auto >= 0) { partner.value = auto; partner.dataset.autoVal = auto; }
          }
        });
        inp.addEventListener('change', () => {
          saveScore(league.id, inp.dataset.fixture, inp.dataset.field, inp.value);
          // Programmatic `.value =` assignment (used by the auto-fill above) does NOT
          // fire a `change` event, so the partner field's score would never reach
          // Firestore. Detect it here and save it explicitly.
          const partnerField = inp.dataset.field === 'homeScore' ? 'awayScore' : 'homeScore';
          const partner = body.querySelector(
            `.score-input[data-fixture="${inp.dataset.fixture}"][data-field="${partnerField}"]`
          );
          if (partner && partner.value !== '') {
            saveScore(league.id, inp.dataset.fixture, partnerField, partner.value);
          }
          openLeagueDetail(id, isAdmin);
        });
      });
    }

    // Venue assignment — admin only
    if (Auth.isAdmin()) {
      body.querySelectorAll('.fixture-venue-sel').forEach(sel => {
        sel.addEventListener('change', () => {
          const fixture = league.fixtures.find(f => f.id === sel.dataset.fixture);
          if (fixture) {
            fixture.venueId   = sel.value;
            const v = DB.getVenues().find(v => v.id === sel.value);
            fixture.venueName = v ? v.name : 'TBA';
            DB.updateLeague(league);
            toast('Venue updated', 'success');
          }
        });
      });

      body.querySelectorAll('[data-fixture-edit]').forEach(btn => {
        btn.addEventListener('click', () => openFixtureEdit(league.id, btn.dataset.fixtureEdit));
      });

      // Okay-clash buttons
      body.querySelectorAll('.okay-clash-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const reason = prompt('Reason for okaying this clash (e.g. venue has enough courts, or alternate venue will be arranged):');
          if (reason === null) return; // cancelled
          const fixture = (league.fixtures || []).find(f => f.id === btn.dataset.fid);
          if (fixture) {
            const profile = Auth.getProfile();
            fixture.clashOkayed   = true;
            fixture.clashReason   = reason.trim();
            fixture.clashOkayedBy = profile ? (profile.displayName || profile.email) : 'Admin';
            DB.updateLeague(league);
            DB.writeAudit('clash_okayed', 'league',
              `Clash okayed for ${fixture.homeSchoolName} vs ${fixture.awaySchoolName}: ${reason}`,
              league.id, league.name);
            toast('Clash acknowledged ✓', 'success');
            openLeagueDetail(id, isAdmin);
          }
        });
      });

      // Apply / dismiss change requests
      body.querySelectorAll('.apply-cr-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const fixture = (league.fixtures || []).find(f => f.id === btn.dataset.fid);
          if (!fixture || !fixture.changeRequest) return;
          const cr = fixture.changeRequest;
          if (cr.requestedDate)    fixture.date      = cr.requestedDate;
          if (cr.requestedTime)    fixture.timeSlot  = cr.requestedTime;
          if (cr.requestedVenueId) {
            fixture.venueId   = cr.requestedVenueId;
            const v = DB.getVenues().find(v => v.id === cr.requestedVenueId);
            fixture.venueName = v ? v.name : 'TBA';
          }
          fixture.clashOkayed   = false;
          fixture.clashReason   = null;
          delete fixture.changeRequest;
          DB.updateLeague(league);
          toast('Change request applied ✓', 'success');
          openLeagueDetail(id, isAdmin);
          Calendar.refresh();
          // Notify both schools about the updated fixture
          if (typeof NotificationService !== 'undefined') {
            NotificationService.sendToSchoolGroup(
              [fixture.homeSchoolId, fixture.awaySchoolId].filter(Boolean),
              {
                type:      'fixture_changed',
                title:     'Fixture updated',
                body:      `${fixture.homeSchoolName || 'Home'} vs ${fixture.awaySchoolName || 'Away'} has been rescheduled to ${formatDate(fixture.date)}${fixture.venueName ? ' at ' + fixture.venueName : ''}.`,
                leagueId:  league.id,
                fixtureId: fixture.id,
              }
            );
          }
        });
      });
      body.querySelectorAll('.reject-cr-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const fixture = (league.fixtures || []).find(f => f.id === btn.dataset.fid);
          const crUid   = fixture && fixture.changeRequest ? fixture.changeRequest.requestedBy : null;
          if (fixture) { delete fixture.changeRequest; DB.updateLeague(league); }
          // Notify the user who submitted the request that it was dismissed
          if (crUid && typeof NotificationService !== 'undefined') {
            NotificationService.send({
              type:      'fixture_changed',
              title:     'Change request not approved',
              body:      `Your change request for ${fixture.homeSchoolName || 'Home'} vs ${fixture.awaySchoolName || 'Away'} was not approved.`,
              recipientUids: [crUid],
              leagueId:  league.id,
              fixtureId: fixture.id,
            });
          }
          toast('Request dismissed');
          openLeagueDetail(id, isAdmin);
        });
      });
    }

    // Verify score buttons — any logged-in user (restricted by role inside verifyScore)
    body.querySelectorAll('.verify-btn').forEach(btn => {
      btn.addEventListener('click', () => verifyScore(btn.dataset.lid, btn.dataset.fid, btn.dataset.as, id, isAdmin));
    });

    // Recalculate fixtures — admin only (buttons appear in fixtures tab AND balance tab)
    body.querySelectorAll('.recalc-fixtures-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const leagueStarted = (league.fixtures || []).some(f => f.homeScore !== null && f.homeScore !== undefined);
        if (leagueStarted) {
          toast('Cannot recalculate — scores have already been entered for this league. Edit individual fixtures manually.', 'error');
          return;
        }
        if (!confirm('Recalculate fixtures?\n\nManually-set venue, date and time edits will be preserved where possible. Only unedited fixtures will be rescheduled.')) return;
        const parts = _getParticipants(league);
        // Snapshot manually-edited fields before regenerating
        const manualOverrides = {};
        (league.fixtures || []).forEach(f => {
          manualOverrides[`${f.homeParticipantId}|${f.awayParticipantId}`] = {
            venueId: f.venueId, venueName: f.venueName,
            date: f.date, timeSlot: f.timeSlot, courtIndex: f.courtIndex,
          };
        });
        let newFixtures;
        try {
          newFixtures = generateFixtures(parts, league.homeMatches ?? 1, league.startDate, league.neutralVenueId, league.playingDay, league.matchTime, league.id, league.endDate, league.excludedDates);
        } catch (err) {
          console.error('generateFixtures error (recalc):', err);
          toast('Error recalculating fixtures: ' + err.message, 'error');
          return;
        }
        // Merge back manual overrides for matching home/away pair
        newFixtures.forEach(f => {
          const key = `${f.homeParticipantId}|${f.awayParticipantId}`;
          if (manualOverrides[key]) Object.assign(f, manualOverrides[key]);
        });
        league.fixtures  = newFixtures;
        league.standings = generateStandings(parts);
        DB.updateLeague(league);
        DB.writeAudit('fixtures_recalculated', 'league', `Fixtures recalculated (clash-aware) for ${league.name}`, league.id, league.name);
        // Check if any forced clashes remain
        const remaining = DB.detectFixtureClashes().filter(({ a, b }) => a.leagueId === league.id || b.leagueId === league.id);
        if (remaining.length > 0) {
          toast(`⚠️ ${remaining.length} clash${remaining.length > 1 ? 'es' : ''} could not be resolved automatically — please okay or arrange alternate venues.`, 'error');
        } else {
          toast('Fixtures recalculated — no clashes ✓', 'success');
        }
        openLeagueDetail(id, isAdmin);
        Calendar.refresh();
      });
    });

    const footer = document.getElementById('leagueDetailFooter');
    footer.innerHTML = `
      <button class="btn btn-secondary" data-modal="leagueDetailModal">Close</button>
      <button class="btn btn-outline-primary" id="exportFixturesBtn">⬇ Export Fixtures CSV</button>
      <button class="btn btn-outline-primary" id="exportStandingsBtn">⬇ Export Standings CSV</button>`;
    document.getElementById('exportFixturesBtn').addEventListener('click', () => _exportFixturesCSV(league));
    document.getElementById('exportStandingsBtn').addEventListener('click', () => _exportStandingsCSV(league));

    Modal.open('leagueDetailModal');

    // Scroll to and highlight a specific fixture if requested (e.g. from notification)
    if (highlightFixtureId) {
      setTimeout(() => {
        const row = body.querySelector(`tr[data-fixture-row="${highlightFixtureId}"]`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('fixture-highlight');
          setTimeout(() => row.classList.remove('fixture-highlight'), 3000);
        }
      }, 120);
    }
  }

  function _fixturesTab(league, schools, isAdmin) {
    const venues     = DB.getVenues();
    const fixtures   = league.fixtures || [];
    if (fixtures.length === 0) return `<p class="text-muted text-center" style="padding:1.5rem">No fixtures generated.</p>`;

    // Pre-compute clashed fixture IDs for this render
    const clashedIds = new Set();
    for (const { a, b } of DB.detectFixtureClashes()) {
      if (a.leagueId === league.id || b.leagueId === league.id) {
        clashedIds.add(a.fixture.id);
        clashedIds.add(b.fixture.id);
      }
    }

    const byRound = {};
    fixtures.forEach(f => {
      const r = f.round || 1;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(f);
    });

    // Count unresolved clashes involving this league's fixtures
    const unresolved = [...clashedIds].filter(fid => {
      const f = fixtures.find(x => x.id === fid);
      return f && !f.clashOkayed;
    });

    const leagueStarted = fixtures.some(f => f.homeScore !== null && f.homeScore !== undefined);

    let html = '';

    // Admin toolbar — always show Recalculate button when league not yet started
    if (Auth.isAdmin()) {
      html += `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">`;
      if (leagueStarted) {
        html += `<span class="text-muted" style="font-size:.78rem">League in progress — edit individual fixtures manually.</span>`;
      } else {
        html += `<button class="btn btn-xs btn-warning recalc-fixtures-btn">🔄 Recalculate Fixtures</button>`;
      }
      html += `</div>`;
    }

    if (unresolved.length > 0) {
      const clashCount = unresolved.length / 2;
      html += `<div class="fixture-clash-badge" style="margin-bottom:1rem;border-radius:var(--radius)">
        ⚠️ ${Math.ceil(clashCount)} venue clash${clashCount > 1 ? 'es' : ''} detected in this league's fixtures.
        ${Auth.isAdmin() && !leagueStarted ? '' : (!Auth.isAdmin() ? `Contact an admin to resolve the clash${clashCount > 1 ? 'es' : ''}.` : '')}
      </div>`;
    }

    Object.keys(byRound).sort((a, b) => a - b).forEach(r => {
      html += `<div style="margin-bottom:1.25rem">
        <div class="round-label">Round ${r}</div>
        <table class="fixtures-table">
          <thead><tr>
            <th>Date</th><th>Time</th><th>Home</th><th>Score</th><th>Away</th><th>Venue</th>
            ${isAdmin ? '<th></th>' : ''}
          </tr></thead>
          <tbody>`;

      byRound[r].forEach(f => {
        const homeSchool = schools.find(s => s.id === f.homeSchoolId);
        const awaySchool = schools.find(s => s.id === f.awaySchoolId);
        const homeColor  = homeSchool ? homeSchool.color : '#666';
        const awayColor  = awaySchool ? awaySchool.color : '#666';
        const hasScore   = f.homeScore !== null && f.homeScore !== undefined;

        const venueCell = Auth.isAdmin()
          ? `<select class="score-input fixture-venue-sel" style="width:auto;padding:.2rem;font-size:.78rem" data-fixture="${f.id}">
              ${venues.map(v => `<option value="${v.id}"${v.id === f.venueId ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}
              <option value=""${!f.venueId ? ' selected' : ''}>TBA</option>
            </select>`
          : esc(f.venueName || 'TBA');

        // Determine whether the logged-in user may enter scores for this fixture.
        // Admins can always edit; regular users only for their own school's games.
        const _prof        = Auth.getProfile();
        const _mySchool    = _prof ? _prof.schoolId : null;
        const canEnterScore = isAdmin
          || (_mySchool && (_mySchool === f.homeSchoolId || _mySchool === f.awaySchoolId));

        const scoreCell = canEnterScore
          ? `<div class="score-cell">
              <input class="score-input" type="number" min="0" max="99" value="${hasScore ? f.homeScore : ''}" data-fixture="${f.id}" data-field="homeScore" style="width:54px">
              <span style="margin:0 .25rem;color:var(--neutral)">—</span>
              <input class="score-input" type="number" min="0" max="99" value="${hasScore ? f.awayScore : ''}" data-fixture="${f.id}" data-field="awayScore" style="width:54px">
            </div>
            ${_verifyBadge(f, league.id)}`
          : hasScore
            ? `<strong>${f.homeScore} — ${f.awayScore}</strong>${_verifyBadge(f, league.id)}`
            : `<span class="text-muted">vs</span>`;

        const clashRow      = _clashBadge(f, league.id, clashedIds);
        const changeReqRow  = _changeRequestBadge(f, league.id);

        const editBtn = isAdmin
          ? `<td><button class="btn btn-xs btn-secondary" data-fixture-edit="${f.id}" title="Edit fixture">✏️</button></td>`
          : '';

        html += `<tr data-fixture-row="${f.id}" class="${clashedIds.has(f.id) && !f.clashOkayed ? 'fixture-row-clash' : ''}">
          <td style="white-space:nowrap">${f.date ? formatDate(f.date) : '—'}</td>
          <td style="white-space:nowrap">${f.timeSlot || '—'}</td>
          <td><span style="color:${homeColor}">●</span> ${esc(f.homeSchoolName)}</td>
          <td style="text-align:center">${scoreCell}</td>
          <td><span style="color:${awayColor}">●</span> ${esc(f.awaySchoolName)}</td>
          <td style="font-size:.78rem">${f.isNeutral ? '<span class="badge badge-gray">Neutral</span> ' : ''}${venueCell}</td>
          ${editBtn}
        </tr>
        ${clashRow    ? `<tr class="fixture-sub-row"><td colspan="${isAdmin ? 7 : 6}">${clashRow}</td></tr>` : ''}
        ${changeReqRow ? `<tr class="fixture-sub-row"><td colspan="${isAdmin ? 7 : 6}">${changeReqRow}</td></tr>` : ''}`;
      });

      html += `</tbody></table></div>`;
    });
    return html;
  }

  /** Home/Away balance tab — shows counts per team and flags imbalance > 1. */
  function _balanceTab(league) {
    const parts = _getParticipants(league);
    if (parts.length === 0) return `<p class="text-muted text-center" style="padding:1.5rem">No teams in this league.</p>`;

    // "Only meet once" leagues have no home/away balance concept — skip the warning entirely
    const meetOnce = (league.homeMatches ?? 1) === 0;

    const counts = {};
    parts.forEach(p => { counts[p.participantId] = { name: _participantName(p), home: 0, away: 0 }; });

    (league.fixtures || []).forEach(f => {
      const hk = f.homeParticipantId || f.homeSchoolId;
      const ak = f.awayParticipantId || f.awaySchoolId;
      if (counts[hk]) counts[hk].home++;
      if (counts[ak]) counts[ak].away++;
    });

    const rows = Object.values(counts);
    const anyImbalance   = rows.some(r => Math.abs(r.home - r.away) > 1);
    const leagueStarted  = (league.fixtures || []).some(f => f.homeScore !== null && f.homeScore !== undefined);

    let html = `<div style="margin-bottom:.75rem">`;
    if (anyImbalance) {
      html += `<div class="fixture-clash-badge" style="margin-bottom:.75rem">
        ⚠️ One or more teams have an unbalanced schedule (home/away difference &gt; 1).
        To fix, go to the <strong>Fixtures</strong> tab and click <strong>🔄 Recalculate Fixtures</strong>.
      </div>`;
    } else {
      const balanceMsg = meetOnce
        ? '✓ Home/Away schedule is balanced (meet-once format — max 1 game difference per team).'
        : '✓ Home/Away schedule is balanced.';
      html += `<div class="clash-okayed-badge" style="margin-bottom:.75rem">${balanceMsg}</div>`;
    }
    html += `<table class="standings-table">
      <thead><tr><th>Team</th><th>Home</th><th>Away</th><th>Total</th><th>Balance</th></tr></thead>
      <tbody>`;
    rows.forEach(r => {
      const diff = Math.abs(r.home - r.away);
      const cls  = diff > 1 ? 'style="background:#fff7ed"' : '';
      html += `<tr ${cls}>
        <td>${esc(r.name)}</td>
        <td style="text-align:center">${r.home}</td>
        <td style="text-align:center">${r.away}</td>
        <td style="text-align:center">${r.home + r.away}</td>
        <td style="text-align:center">${diff > 1 ? `<span class="score-unverified-badge">⚠️ Diff ${diff}</span>` : '<span class="score-verified">✓</span>'}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
    return html;
  }

  function _standingsTab(league, schools) {
    const standings = league.standings || [];
    if (standings.length === 0) return `<p class="text-muted text-center" style="padding:1.5rem">No standings yet.</p>`;

    let html = `<table class="standings-table">
      <thead><tr>
        <th class="school-color"></th>
        <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th>
      </tr></thead><tbody>`;

    standings.forEach((row, i) => {
      const school = schools.find(s => s.id === row.schoolId);
      const color  = school ? school.color : '#ccc';
      html += `<tr>
        <td class="school-color" style="background:${color}"></td>
        <td>${i + 1}</td>
        <td>${esc(row.name)}</td>
        <td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td>
        <td><strong>${row.points}</strong></td>
      </tr>`;
    });

    return html + `</tbody></table>`;
  }

  // ════════════════════════════════════════════════════════════
  // FIXTURE EDIT MODAL (master only)
  // ════════════════════════════════════════════════════════════
  function openFixtureEdit(leagueId, fixtureId) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;

    document.getElementById('fixtureEditInfo').innerHTML =
      `<strong>${esc(fixture.homeSchoolName)} vs ${esc(fixture.awaySchoolName)}</strong>
       <span class="text-muted"> · Round ${fixture.round} · ${esc(league.name)}</span>`;

    document.getElementById('fixtureEditDate').value = fixture.date     || '';
    document.getElementById('fixtureEditTime').value = fixture.timeSlot || '14:00';
    document.getElementById('fixtureEditLeagueId').value  = leagueId;
    document.getElementById('fixtureEditId').value        = fixtureId;

    const vSel = document.getElementById('fixtureEditVenue');
    vSel.innerHTML = `<option value="">TBA</option>` +
      DB.getVenues().map(v => `<option value="${v.id}"${v.id === fixture.venueId ? ' selected' : ''}>${esc(v.name)}</option>`).join('');

    _updateFixtureCourtList(fixture.courtIndex);

    // Wire venue/date/court changes → refresh block options + summary
    document.getElementById('fixtureEditVenue').onchange = () => _updateFixtureCourtList(null);
    document.getElementById('fixtureEditDate').onchange  = () => _updateFixtureCourtList(null);
    document.getElementById('fixtureEditCourt').onchange = _updateFixtureCourtSummary;

    Modal.open('fixtureEditModal');
  }

  function _courtsBookedForVenueDate(venueId, dateStr, excludeId) {
    if (!venueId) return 3;
    const venue = DB.getVenues().find(v => v.id === venueId);
    if (!venue) return 3;
    const vc = venue.courts || 0;
    if (vc === 0) return 1;
    // Count fixtures at this venue+date, excluding the one being edited
    const others = DB.getLeagues()
      .flatMap(l => l.fixtures || [])
      .filter(f => f.venueId === venueId && f.date === dateStr && f.id !== excludeId)
      .length;
    const total = others + 1; // +1 for the fixture being edited
    return Math.min(3, Math.max(1, Math.floor(vc / total)));
  }

  function _updateFixtureCourtList(preselect) {
    const venueId      = document.getElementById('fixtureEditVenue').value;
    const dateVal      = document.getElementById('fixtureEditDate').value;
    const fixtureId    = document.getElementById('fixtureEditId').value;
    const venue        = DB.getVenues().find(v => v.id === venueId);
    const sel          = document.getElementById('fixtureEditCourt');
    sel.innerHTML      = `<option value="">Any court</option>`;
    if (venue) {
      const vCourts      = venue.courts || 0;
      const courtsBooked = _courtsBookedForVenueDate(venueId, dateVal, fixtureId);
      // Step by courtsBooked to show non-overlapping blocks
      for (let i = 0; i + courtsBooked <= vCourts; i += courtsBooked) {
        const label    = courtsBooked > 1
          ? `Courts ${i + 1}–${i + courtsBooked}`
          : `Court ${i + 1}`;
        const selected = (preselect !== undefined && preselect !== null && parseInt(preselect) === i) ? ' selected' : '';
        sel.innerHTML += `<option value="${i}"${selected}>${label}</option>`;
      }
    }
    _updateFixtureCourtSummary();
  }

  function _updateFixtureCourtSummary() {
    const summaryEl = document.getElementById('fixtureCourtSummary');
    if (!summaryEl) return;
    const venueId   = document.getElementById('fixtureEditVenue').value;
    const dateVal   = document.getElementById('fixtureEditDate').value;
    const fixtureId = document.getElementById('fixtureEditId').value;
    const venue     = DB.getVenues().find(v => v.id === venueId);
    if (!venue) { summaryEl.textContent = ''; return; }
    const courtsBooked = _courtsBookedForVenueDate(venueId, dateVal, fixtureId);
    const durationH    = courtsBooked >= 3 ? 3 : 4;
    const courtVal     = document.getElementById('fixtureEditCourt').value;
    const startCourt   = courtVal !== '' ? parseInt(courtVal) + 1 : 1;
    const endCourt     = startCourt + courtsBooked - 1;
    const range        = courtsBooked > 1 ? `Courts ${startCourt}–${endCourt}` : `Court ${startCourt}`;
    const others = dateVal
      ? DB.getLeagues().flatMap(l => l.fixtures || [])
          .filter(f => f.venueId === venueId && f.date === dateVal && f.id !== fixtureId).length
      : 0;
    const shareNote = others > 0 ? ` · ${others + 1} fixtures share venue` : '';
    summaryEl.textContent = `📋 ${range} · ${courtsBooked} court${courtsBooked > 1 ? 's' : ''} booked · ${durationH}h duration${shareNote}`;
  }

  function saveFixtureEdit() {
    const leagueId  = document.getElementById('fixtureEditLeagueId').value;
    const fixtureId = document.getElementById('fixtureEditId').value;
    const league    = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture   = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;

    const newDate     = document.getElementById('fixtureEditDate').value;
    const newTime     = document.getElementById('fixtureEditTime').value;
    const newVenueId  = document.getElementById('fixtureEditVenue').value;
    const newCourt    = document.getElementById('fixtureEditCourt').value;

    const venueObj   = newVenueId ? DB.getVenues().find(v => v.id === newVenueId) : null;
    fixture.date       = newDate    || fixture.date;
    fixture.timeSlot   = newTime    || fixture.timeSlot;
    fixture.venueId    = newVenueId || null;
    fixture.venueName  = venueObj ? (venueObj.name || 'TBA') : 'TBA';
    fixture.courtIndex = newCourt !== '' ? parseInt(newCourt) : null;
    // courtsBooked accounts for other fixtures sharing this venue+date
    fixture.courtsBooked = _courtsBookedForVenueDate(
      fixture.venueId,
      fixture.date,
      fixture.id
    );

    DB.updateLeague(league);
    DB.writeAudit(
      'fixture_edited', 'league',
      `Fixture edited: ${fixture.homeSchoolName} vs ${fixture.awaySchoolName} → ${newDate} ${newTime}`,
      leagueId, league.name
    );

    Modal.close('fixtureEditModal');
    // Refresh the detail modal if it's open
    openLeagueDetail(leagueId, true);
    renderAdmin();
    toast('Fixture updated ✓', 'success');
  }

  // ════════════════════════════════════════════════════════════
  // DELETE
  // ════════════════════════════════════════════════════════════
  async function deleteLeague(id) {
    if (!confirm('Delete this league and all its fixtures?')) return;
    const league = DB.getLeagues().find(l => l.id === id);
    DB.writeAudit('league_deleted', 'league', `Deleted league: ${league ? league.name : id}`, id, league ? league.name : null);
    const deletePromise = DB.deleteLeague(id);  // optimistically removes from cache
    render();
    renderAdmin();
    try {
      await deletePromise;
      toast('League deleted', 'success');
    } catch(e) {
      console.error('League delete failed:', e);
      toast('Delete failed — ' + (e.message || 'permission denied'), 'error');
      render();      // re-render after onSnapshot revert restores the league
      renderAdmin();
    }
  }

  /**
   * Update a single fixture score from any module (e.g. MySchool).
   * Always resets all verification flags so the process starts fresh.
   * The entering team's own flag is then set (they've seen the current score).
   * Recalculates standings and persists to DB.
   */
  function saveScore(leagueId, fixtureId, field, rawValue) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;
    const oldVal  = fixture[field];
    // Empty string / null / undefined / unparseable string (e.g. the literal
    // "null" that appears when an input renders a null value attribute) → clear
    // to null. parseInt("null") = NaN, so guard against that too.
    const _parsed = parseInt(rawValue);
    fixture[field] = (rawValue === '' || rawValue === null || rawValue === undefined || isNaN(_parsed))
      ? null
      : _parsed;

    // Any score change resets all verification — the process starts fresh.
    fixture.masterVerified   = false;
    fixture.homeTeamVerified = false;
    fixture.awayTeamVerified = false;

    // The entering team implicitly verifies their own side (they entered the score).
    // Admin entries do NOT auto-verify; they must use Master ✓ explicitly.
    const profile    = Auth.getProfile();
    const mySchoolId = profile ? profile.schoolId : null;
    if (mySchoolId && !Auth.isAdmin()) {
      if (mySchoolId === fixture.homeSchoolId) {
        fixture.homeTeamVerified = true;
      } else if (mySchoolId === fixture.awaySchoolId) {
        fixture.awayTeamVerified = true;
      }
    }

    recalcStandings(league);
    DB.updateLeague(league);
    DB.writeAudit(
      'score_updated', 'league',
      `Score: ${fixture.homeSchoolName} vs ${fixture.awaySchoolName} — ${field}: ${oldVal ?? 'blank'} → ${fixture[field]}`,
      leagueId, league.name
    );
    toast('Score saved ✓', 'success');
    render();
  }

  /**
   * Verify a score on behalf of a team or as master.
   * @param {string} leagueId
   * @param {string} fixtureId
   * @param {string} as        'home' | 'away' | 'master'
   * @param {string} reopenId  league id to reopen detail modal (same as leagueId)
   * @param {boolean} isAdmin  whether detail was opened in admin mode
   */
  function verifyScore(leagueId, fixtureId, as, reopenId, isAdmin) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;

    // Permission guards
    if (as === 'master' && !Auth.isAdmin()) { toast('Only admin can master-verify', 'error'); return; }
    if (as === 'home' || as === 'away') {
      // Only the school contact for that side can verify
      const profile    = Auth.getProfile();
      const mySchoolId = profile ? profile.schoolId : null;
      if (as === 'home' && mySchoolId !== fixture.homeSchoolId) { toast('Only the home team can verify here', 'error'); return; }
      if (as === 'away' && mySchoolId !== fixture.awaySchoolId) { toast('Only the away team can verify here', 'error'); return; }
    }

    if (as === 'master') {
      fixture.masterVerified   = true;
      fixture.homeTeamVerified = true;
      fixture.awayTeamVerified = true;
    } else if (as === 'home') {
      fixture.homeTeamVerified = true;
    } else if (as === 'away') {
      fixture.awayTeamVerified = true;
    }

    DB.updateLeague(league);
    DB.writeAudit(
      'score_verified', 'league',
      `Score verified (${as}): ${fixture.homeSchoolName} vs ${fixture.awaySchoolName} — ${fixture.homeScore}–${fixture.awayScore}`,
      leagueId, league.name
    );
    toast('Score verified ✓', 'success');
    openLeagueDetail(reopenId || leagueId, isAdmin);
  }

  // ── Score Sheet ─────────────────────────────────────────────

  /**
   * Open the score sheet modal for a fixture.
   * Pre-fills fixture metadata; loads any previously saved scoreSheet data.
   */
  function openScoreSheet(leagueId, fixtureId) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;

    const ss = fixture.scoreSheet || {};

    // Pre-fill header fields
    document.getElementById('ssLeagueId').value  = leagueId;
    document.getElementById('ssFixtureId').value = fixtureId;
    document.getElementById('ssLeague').value    = league.name || '';
    document.getElementById('ssDate').value      = fixture.date ? formatDate(fixture.date) : '—';
    document.getElementById('ssHomeTeam').value  = fixture.homeSchoolName  || '';
    document.getElementById('ssVisitTeam').value = fixture.awaySchoolName  || '';

    const genderSel   = document.getElementById('ssGender');
    const ageGroupSel = document.getElementById('ssAgeGroup');
    genderSel.value   = ss.gender   || '';
    ageGroupSel.value = ss.ageGroup || '';

    document.getElementById('scoreSheetTitle').textContent =
      `📋 Score Sheet — ${fixture.homeSchoolName} vs ${fixture.awaySchoolName}`;

    // Build singles rows (4)
    const singlesData = ss.singles || Array.from({ length: 4 }, () => ({}));
    document.getElementById('ssSinglesBody').innerHTML = singlesData.map((r, i) =>
      `<tr>
        <td style="padding:.25rem .3rem;border:1px solid #ddd">
          <input class="search-input ss-input" style="width:100%;padding:.25rem .4rem"
            data-section="singles" data-idx="${i}" data-field="homePlayer"
            value="${esc(r.homePlayer || '')}" placeholder="Player name">
        </td>
        <td style="padding:.25rem .3rem;border:1px solid #ddd">
          <input class="search-input ss-input" style="width:100%;padding:.25rem .4rem"
            data-section="singles" data-idx="${i}" data-field="visitorPlayer"
            value="${esc(r.visitorPlayer || '')}" placeholder="Player name">
        </td>
        <td style="padding:.25rem .3rem;border:1px solid #ddd;text-align:center">
          <input class="search-input ss-input ss-games" style="width:60px;text-align:center;padding:.25rem .3rem"
            type="number" min="0" max="99"
            data-section="singles" data-idx="${i}" data-field="homeGames"
            value="${r.homeGames !== null && r.homeGames !== undefined ? r.homeGames : ''}">
        </td>
        <td style="padding:.25rem .3rem;border:1px solid #ddd;text-align:center">
          <input class="search-input ss-input ss-games" style="width:60px;text-align:center;padding:.25rem .3rem"
            type="number" min="0" max="99"
            data-section="singles" data-idx="${i}" data-field="visitorGames"
            value="${r.visitorGames !== null && r.visitorGames !== undefined ? r.visitorGames : ''}">
        </td>
      </tr>`
    ).join('');

    // Build doubles rows (2)
    const doublesData = ss.doubles || Array.from({ length: 2 }, () => ({}));
    document.getElementById('ssDoublesBody').innerHTML = doublesData.map((r, i) =>
      `<tr>
        <td style="padding:.25rem .3rem;border:1px solid #ddd">
          <input class="search-input ss-input" style="width:100%;padding:.25rem .4rem"
            data-section="doubles" data-idx="${i}" data-field="homePlayer"
            value="${esc(r.homePlayer || '')}" placeholder="Players (e.g. Smith / Jones)">
        </td>
        <td style="padding:.25rem .3rem;border:1px solid #ddd">
          <input class="search-input ss-input" style="width:100%;padding:.25rem .4rem"
            data-section="doubles" data-idx="${i}" data-field="visitorPlayer"
            value="${esc(r.visitorPlayer || '')}" placeholder="Players">
        </td>
        <td style="padding:.25rem .3rem;border:1px solid #ddd;text-align:center">
          <input class="search-input ss-input ss-games" style="width:60px;text-align:center;padding:.25rem .3rem"
            type="number" min="0" max="99"
            data-section="doubles" data-idx="${i}" data-field="homeGames"
            value="${r.homeGames !== null && r.homeGames !== undefined ? r.homeGames : ''}">
        </td>
        <td style="padding:.25rem .3rem;border:1px solid #ddd;text-align:center">
          <input class="search-input ss-input ss-games" style="width:60px;text-align:center;padding:.25rem .3rem"
            type="number" min="0" max="99"
            data-section="doubles" data-idx="${i}" data-field="visitorGames"
            value="${r.visitorGames !== null && r.visitorGames !== undefined ? r.visitorGames : ''}">
        </td>
      </tr>`
    ).join('');

    // Signatures
    document.getElementById('ssHomeSig').value  = ss.homeSignature  || '';
    document.getElementById('ssVisitSig').value = ss.visitorSignature || '';

    _ssRecalcTotals();

    // Wire live recalc on any game-score change
    document.getElementById('ssSinglesBody').querySelectorAll('.ss-games').forEach(inp => {
      inp.addEventListener('input', _ssRecalcTotals);
    });
    document.getElementById('ssDoublesBody').querySelectorAll('.ss-games').forEach(inp => {
      inp.addEventListener('input', _ssRecalcTotals);
    });

    Modal.open('scoreSheetModal');
  }

  /** Recalculate and display Singles, Doubles, and Grand totals in the modal. */
  function _ssRecalcTotals() {
    const sumInputs = selector => {
      let total = 0, hasAny = false;
      document.querySelectorAll(selector).forEach(inp => {
        const v = parseInt(inp.value);
        if (!isNaN(v)) { total += v; hasAny = true; }
      });
      return hasAny ? total : null;
    };

    const sH = sumInputs('#ssSinglesBody [data-field="homeGames"]');
    const sV = sumInputs('#ssSinglesBody [data-field="visitorGames"]');
    const dH = sumInputs('#ssDoublesBody [data-field="homeGames"]');
    const dV = sumInputs('#ssDoublesBody [data-field="visitorGames"]');

    document.getElementById('ssSinglesHomeTotal').textContent  = sH !== null ? sH : '—';
    document.getElementById('ssSinglesVisitTotal').textContent = sV !== null ? sV : '—';
    document.getElementById('ssDoublesHomeTotal').textContent  = dH !== null ? dH : '—';
    document.getElementById('ssDoublesVisitTotal').textContent = dV !== null ? dV : '—';

    const gH = (sH !== null || dH !== null) ? ((sH || 0) + (dH || 0)) : null;
    const gV = (sV !== null || dV !== null) ? ((sV || 0) + (dV || 0)) : null;
    document.getElementById('ssGrandHomeTotal').textContent  = gH !== null ? gH : '—';
    document.getElementById('ssGrandVisitTotal').textContent = gV !== null ? gV : '—';
  }

  /** Collect the form, persist to fixture.scoreSheet, and update homeScore/awayScore. */
  function saveScoreSheet() {
    const leagueId  = document.getElementById('ssLeagueId').value;
    const fixtureId = document.getElementById('ssFixtureId').value;
    const league    = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture   = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;

    // Collect rows
    const collectRows = (section, count) =>
      Array.from({ length: count }, (_, i) => {
        const val = field => {
          const el = document.querySelector(`[data-section="${section}"][data-idx="${i}"][data-field="${field}"]`);
          return el ? el.value.trim() : '';
        };
        const gH = parseInt(val('homeGames'));
        const gV = parseInt(val('visitorGames'));
        return {
          homePlayer:    val('homePlayer'),
          visitorPlayer: val('visitorPlayer'),
          homeGames:    isNaN(gH) ? null : gH,
          visitorGames: isNaN(gV) ? null : gV,
        };
      });

    const singles = collectRows('singles', 4);
    const doubles = collectRows('doubles', 2);

    const sumGames = (rows, field) => rows.reduce((s, r) => s + (r[field] !== null ? r[field] : 0), 0);
    const grandHome  = sumGames(singles, 'homeGames')    + sumGames(doubles, 'homeGames');
    const grandVisit = sumGames(singles, 'visitorGames') + sumGames(doubles, 'visitorGames');
    const hasGames   = singles.some(r => r.homeGames !== null || r.visitorGames !== null) ||
                       doubles.some(r => r.homeGames !== null || r.visitorGames !== null);

    fixture.scoreSheet = {
      gender:           document.getElementById('ssGender').value,
      ageGroup:         document.getElementById('ssAgeGroup').value,
      singles,
      doubles,
      homeSignature:    document.getElementById('ssHomeSig').value.trim(),
      visitorSignature: document.getElementById('ssVisitSig').value.trim(),
      savedAt:          new Date().toISOString(),
    };

    // Update the overall match score from the grand totals when games were entered
    if (hasGames) {
      fixture.homeScore = grandHome;
      fixture.awayScore = grandVisit;
      // The entering team auto-verifies their side
      const profile    = Auth.getProfile();
      const mySchoolId = profile ? profile.schoolId : null;
      fixture.masterVerified   = false;
      fixture.homeTeamVerified = false;
      fixture.awayTeamVerified = false;
      if (mySchoolId && !Auth.isAdmin()) {
        if (mySchoolId === fixture.homeSchoolId)      fixture.homeTeamVerified = true;
        else if (mySchoolId === fixture.awaySchoolId) fixture.awayTeamVerified = true;
      }
      recalcStandings(league);
    }

    DB.updateLeague(league);
    DB.writeAudit('scoresheet_saved', 'league',
      `Score sheet saved: ${fixture.homeSchoolName} vs ${fixture.awaySchoolName}`,
      leagueId, league.name);
    toast('Score sheet saved ✓', 'success');
    Modal.close('scoreSheetModal');
    render();
  }

  // Wire the Save button (once, on module init — safe to call repeatedly)
  function _initScoreSheetModal() {
    const btn = document.getElementById('scoreSheetSaveBtn');
    if (btn && !btn.dataset.bound) {
      btn.addEventListener('click', saveScoreSheet);
      btn.dataset.bound = '1';
    }
  }

  // ── CSV Export helpers ────────────────────────────────────────
  function _csvRow(cells) {
    return cells.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',');
  }
  function _downloadCSV(filename, rows) {
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function _exportFixturesCSV(league) {
    const rows = [_csvRow(['Round','Date','Time','Home','Away','Venue','Home Score','Away Score','Verified'])];
    (league.fixtures || []).forEach(f => {
      const verified = f.masterVerified ? 'Master' : (f.homeTeamVerified && f.awayTeamVerified) ? 'Both teams' : f.homeTeamVerified ? 'Home only' : f.awayTeamVerified ? 'Away only' : 'No';
      rows.push(_csvRow([f.round, f.date, f.timeSlot, f.homeSchoolName, f.awaySchoolName, f.venueName, f.homeScore ?? '', f.awayScore ?? '', verified]));
    });
    _downloadCSV(`${league.name.replace(/[^a-z0-9]/gi,'_')}_fixtures.csv`, rows);
  }
  function _exportStandingsCSV(league) {
    const rows = [_csvRow(['Position','Team','Played','Won','Drawn','Lost','Points'])];
    (league.standings || []).forEach((s, i) => {
      rows.push(_csvRow([i + 1, s.name, s.played, s.won, s.drawn, s.lost, s.points]));
    });
    _downloadCSV(`${league.name.replace(/[^a-z0-9]/gi,'_')}_standings.csv`, rows);
  }

  return { init, refresh, render, renderAdmin, openLeagueModal, openLeagueDetail, saveScore, verifyScore,
           openEntriesModal, renderPendingEntries, openScoreSheet };
})();
