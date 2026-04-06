/**
 * myschool.js — Personalised "My School" view + admin impersonation.
 *
 * Normal mode  : shows the school that is linked to Auth.getProfile().schoolId
 * Impersonate  : admin calls MySchool.impersonate(schoolId) to view any school
 *                as if they were a contact for that school.
 *
 * Banner       : a yellow bar shown while impersonating with an "Exit" button.
 * Score submit : calls Leagues.saveScore() so standings stay in sync.
 */

const MySchool = (() => {

  // ── state ────────────────────────────────────────────────────
  let _impersonateSchoolId = null;   // null = normal mode
  let _divFilter           = '';     // division filter ('') = all
  let _fixtureView         = 'all';  // 'all' | 'next'

  // ── helpers ─────────────────────────────────────────────────
  /** Backward-compatible participant list for a league. */
  function _parts(league) {
    return league.participants && league.participants.length > 0
      ? league.participants
      : (league.schoolIds || []).map(id => ({ participantId: id, schoolId: id, teamSuffix: '' }));
  }

  /** The school ID currently being displayed (impersonated takes priority). */
  function _activeSchoolId() {
    if (_impersonateSchoolId) return _impersonateSchoolId;
    const profile = Auth.getProfile();
    return profile ? profile.schoolId : null;
  }

  // ── banner ───────────────────────────────────────────────────
  function _updateBanner(school) {
    const banner = document.getElementById('impersonateBanner');
    if (!banner) return;
    if (_impersonateSchoolId && school) {
      document.getElementById('impersonateSchoolName').textContent = school.name;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  // ── nav button ───────────────────────────────────────────────
  function _syncNav() {
    const btn = document.querySelector('[data-view="myschool"]');
    if (!btn) return;
    const hasSchool = Auth.isLoggedIn() && (_impersonateSchoolId || _activeSchoolId());
    btn.classList.toggle('hidden', !hasSchool);
    // If the nav button is now hidden but the view is active, fall back to calendar
    if (!hasSchool) {
      const view = document.getElementById('view-myschool');
      if (view && !view.classList.contains('hidden')) {
        document.querySelector('[data-view="calendar"]')?.click();
      }
    }
  }

  // ── public API ───────────────────────────────────────────────
  function init() {
    // Wire up the "Exit School View" button in the banner
    const stopBtn = document.getElementById('stopImpersonateBtn');
    if (stopBtn) stopBtn.addEventListener('click', stopImpersonation);
    // Wire fixture view toggle buttons (once, on DOMContentLoaded)
    const btnAll  = document.getElementById('msViewAll');
    const btnNext = document.getElementById('msViewNext');
    if (btnAll && btnNext) {
      btnAll .addEventListener('click', () => { _fixtureView = 'all';  _syncToggleBtns(); _render(); });
      btnNext.addEventListener('click', () => { _fixtureView = 'next'; _syncToggleBtns(); _render(); });
    }
  }

  function _syncToggleBtns() {
    const btnAll  = document.getElementById('msViewAll');
    const btnNext = document.getElementById('msViewNext');
    if (!btnAll || !btnNext) return;
    btnAll .className = `btn btn-sm ${_fixtureView === 'all'  ? 'btn-primary' : 'btn-secondary'}`;
    btnNext.className = `btn btn-sm ${_fixtureView === 'next' ? 'btn-primary' : 'btn-secondary'}`;
  }

  /**
   * Admin activates school-contact view for a given school.
   * Navigates to the My School tab automatically.
   */
  function impersonate(schoolId) {
    _impersonateSchoolId = schoolId;
    const school = DB.getSchools().find(s => s.id === schoolId);
    _updateBanner(school);

    // Sync My Venue nav now that impersonation context is set
    if (typeof MyVenue !== 'undefined') MyVenue.refresh();

    // Make sure the My School nav button is visible before clicking it
    const navBtn = document.querySelector('[data-view="myschool"]');
    if (navBtn) {
      navBtn.classList.remove('hidden');
      navBtn.click();          // navigate to My School view
    } else {
      _render();               // fallback: just re-render in place
    }
  }

  /** Exit impersonation and return to the Admin view. */
  function stopImpersonation() {
    _impersonateSchoolId = null;
    _updateBanner(null);
    _syncNav();
    if (typeof MyVenue !== 'undefined') MyVenue.refresh();
    // Return to admin if the user is an admin, else calendar
    if (Auth.isAdmin()) {
      document.querySelector('[data-view="admin"]')?.click();
    } else {
      document.querySelector('[data-view="calendar"]')?.click();
    }
  }

  function isImpersonating() { return _impersonateSchoolId !== null; }

  /** Returns the school ID currently in view (impersonated takes priority over logged-in user's own school). */
  function getActiveSchoolId() { return _activeSchoolId(); }

  function refresh() {
    _syncNav();
    _updateBanner(_impersonateSchoolId ? DB.getSchools().find(s => s.id === _impersonateSchoolId) : null);
    const view = document.getElementById('view-myschool');
    if (view && !view.classList.contains('hidden')) _render();
  }

  // ── main render ──────────────────────────────────────────────
  function _render() {
    const container = document.getElementById('myschoolContent');
    if (!container) return;

    const schoolId = _activeSchoolId();
    if (!schoolId) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏫</div>
        <p>No school is linked to your account yet.<br>
           Contact an admin to link your account to your school.</p>
      </div>`;
      return;
    }

    const school = DB.getSchools().find(s => s.id === schoolId);
    if (!school) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏫</div>
        <p>School not found. Contact an admin.</p>
      </div>`;
      return;
    }

    // Update page title
    const title = document.getElementById('myschoolTitle');
    if (title) title.textContent = school.name;

    const venue = school.venueId ? DB.getVenues().find(v => v.id === school.venueId) : null;

    // Populate + wire the division filter (idempotent)
    const divSel = document.getElementById('myschoolDivFilter');
    if (divSel) {
      const allLeagues = DB.getLeagues().filter(l => _parts(l).some(p => p.schoolId === schoolId));
      const divs = [...new Set(allLeagues.map(l => l.division || '').filter(Boolean))].sort();
      divSel.innerHTML = '<option value="">All Divisions</option>' +
        divs.map(d => `<option value="${esc(d)}"${d === _divFilter ? ' selected' : ''}>${esc(d)}</option>`).join('');
      if (!divSel.dataset.bound) {
        divSel.addEventListener('change', e => { _divFilter = e.target.value; _render(); });
        divSel.dataset.bound = '1';
      }
    }

    _syncToggleBtns();

    let myLeagues = DB.getLeagues().filter(l => _parts(l).some(p => p.schoolId === schoolId));
    if (_divFilter) myLeagues = myLeagues.filter(l => (l.division || '') === _divFilter);

    // Pending/rejected entries for leagues where this school is NOT yet a participant
    const enrolledLeagueIds = new Set(myLeagues.map(l => l.id));
    const myEntries = DB.getEntriesForSchool(schoolId).filter(
      e => e.status !== 'rejected' && !enrolledLeagueIds.has(e.leagueId)
    );
    // Group entries by league (may have 2 per league)
    const pendingByLeague = new Map();
    myEntries.forEach(e => {
      if (!pendingByLeague.has(e.leagueId)) pendingByLeague.set(e.leagueId, []);
      pendingByLeague.get(e.leagueId).push(e);
    });

    // Show school header
    const currentProfile = Auth.getProfile();
    const isOwnSchool    = currentProfile && currentProfile.schoolId === schoolId;
    const canSeeSettings = (isOwnSchool || Auth.isAdmin()) && !_impersonateSchoolId;

    let html = `<div class="myschool-header" style="justify-content:space-between;align-items:flex-start">
      <div style="display:flex;gap:.75rem;align-items:flex-start">
        <span class="color-dot" style="background:${school.color};width:20px;height:20px;flex-shrink:0;margin-top:.2rem"></span>
        <div>
          <div class="myschool-school-name">${esc(school.name)}</div>
          ${school.team  ? `<div class="text-muted">${esc(school.team)}</div>` : ''}
          ${venue        ? `<div class="text-muted">🏟 ${esc(venue.name)}</div>` : ''}
          ${(school.organizers && school.organizers.length
              ? school.organizers.map(o => `<div class="text-muted">👤 ${esc(o.name)}${o.email ? ' · ' + esc(o.email) : ''}${o.phone ? ' · ' + esc(o.phone) : ''}</div>`).join('')
              : school.contact ? `<div class="text-muted">👤 ${esc(school.contact)}${school.email ? ' · ' + esc(school.email) : ''}${school.phone ? ' · ' + esc(school.phone) : ''}</div>` : '')}
        </div>
      </div>
      ${canSeeSettings ? `<button class="btn btn-sm btn-secondary" id="ms-settings-shortcut"
          title="Open school settings" style="flex-shrink:0;white-space:nowrap">
          ⚙️ Settings
        </button>` : ''}
    </div>`;

    // ── My School Settings — top of page, collapsed by default ──
    if (canSeeSettings) {
      html += _settingsSection(school, venue);
    }

    // ── Pending entries (awaiting approval) ──────────────────────
    if (pendingByLeague.size > 0) {
      html += `<div class="ms-pending-entries-section">
        <h4 class="ms-section-title">⏳ Pending League Entries</h4>`;
      pendingByLeague.forEach((entries, leagueId) => {
        const league = DB.getLeagues().find(l => l.id === leagueId);
        if (!league) return;
        const DAYS = ['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'];
        const dayLabel = league.playingDay !== undefined ? ' · ' + DAYS[league.playingDay] : '';
        html += `<div class="card ms-pending-entry-card">
          <div class="card-header">
            <div>
              <div class="card-title">${esc(league.name)}</div>
              <div class="text-muted">${esc(league.division || '')}${dayLabel}</div>
            </div>
            <span class="badge badge-amber">⏳ Pending approval</span>
          </div>
          <div class="card-body">
            ${entries.map(e => `<div class="ms-pending-team-row">
              <span class="entry-status--pending" style="font-size:.85rem;font-weight:500">⏳ ${esc(e.teamLabel || e.teamName || 'Team entry')}</span>
              <span class="text-muted" style="font-size:.75rem">Submitted ${e.enteredAt ? new Date(e.enteredAt).toLocaleDateString('en-ZA',{day:'numeric',month:'short',year:'numeric'}) : ''}</span>
            </div>`).join('')}
            ${league.startDate ? `<div class="text-muted mt-1" style="font-size:.8rem">Season: ${formatDate(league.startDate)} → ${league.endDate ? formatDate(league.endDate) : '—'}</div>` : ''}
            ${league.entryDeadline ? `<div class="text-muted" style="font-size:.8rem">📋 Entry deadline: ${formatDate(league.entryDeadline)}</div>` : ''}
          </div>
        </div>`;
      });
      html += `</div>`;
    }

    // ── Approved / enrolled leagues ──────────────────────────────
    if (myLeagues.length === 0 && pendingByLeague.size === 0) {
      html += `<div class="empty-state">
        <div class="empty-icon">🏆</div>
        <p>${_impersonateSchoolId ? 'This school is not enrolled in any leagues yet.' : 'Your school is not enrolled in any leagues yet.'}</p>
      </div>`;
    } else if (myLeagues.length > 0) {
      html += myLeagues.map(l => _leagueSection(l, schoolId)).join('');
    }

    // When impersonating, append a panel showing all notifications sent to this school
    if (_impersonateSchoolId) {
      html += `<div class="card" style="margin-top:1.25rem">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <div class="card-title">📬 Notifications received by this school</div>
          <button class="btn btn-xs btn-secondary" id="refreshSchoolNotifBtn">↻ Refresh</button>
        </div>
        <div class="card-body" style="padding:.5rem 1rem">
          <div id="schoolNotifList"></div>
        </div>
      </div>`;
    }

    container.innerHTML = html;

    // ── Settings collapse toggle + shortcut button ────────────────
    function _openSettings() {
      const body    = document.getElementById('ms-settings-body');
      const chevron = document.getElementById('ms-settings-chevron');
      if (!body) return;
      body.style.display    = 'flex';
      if (chevron) chevron.style.transform = 'rotate(180deg)';
      document.getElementById('ms-settings-card')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const settingsToggle = document.getElementById('ms-settings-toggle');
    if (settingsToggle) {
      settingsToggle.addEventListener('click', () => {
        const body    = document.getElementById('ms-settings-body');
        const chevron = document.getElementById('ms-settings-chevron');
        if (!body) return;
        const isOpen = body.style.display !== 'none';
        body.style.display         = isOpen ? 'none' : 'flex';
        if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
      });
    }
    const settingsShortcut = document.getElementById('ms-settings-shortcut');
    if (settingsShortcut) {
      settingsShortcut.addEventListener('click', _openSettings);
    }

    // ── Settings event handlers ───────────────────────────────────
    const _guardOwnSchool = () => {
      const p = Auth.getProfile();
      if (!Auth.isAdmin() && (!p || p.schoolId !== schoolId)) {
        toast('You can only edit your own school settings', 'error');
        return false;
      }
      return true;
    };

    // Courts: save
    const courtsSaveBtn = document.getElementById('ms-courts-save');
    if (courtsSaveBtn) {
      courtsSaveBtn.addEventListener('click', () => {
        if (!_guardOwnSchool()) return;
        const n = parseInt(document.getElementById('ms-courts-input').value);
        if (isNaN(n) || n < 1) { toast('Enter a valid court count', 'error'); return; }
        const v = DB.getVenues().find(x => x.id === school.venueId);
        if (!v) { toast('No venue linked to this school', 'error'); return; }
        DB.updateVenue({ ...v, courts: n }).catch(console.warn);
        toast('Court count updated ✓', 'success');
        _render();
      });
    }

    // Restricted mode toggle
    const restrictedToggle = document.getElementById('ms-restricted-toggle');
    if (restrictedToggle) {
      restrictedToggle.addEventListener('change', async () => {
        if (!_guardOwnSchool()) return;
        const venue = DB.getVenues().find(v => v.id === school.venueId);
        if (!venue) return;
        venue.restrictedMode = restrictedToggle.checked;
        DB.updateVenue(venue).catch(console.warn);
        toast(venue.restrictedMode ? 'Restricted mode on — add open windows below' : 'Normal mode — add blocked dates below', 'success');
        Calendar.refresh();
        _render();
      });
    }

    // Closures / open windows: add
    const blockAddBtn = document.getElementById('ms-block-add');
    if (blockAddBtn) {
      blockAddBtn.addEventListener('click', () => {
        if (!_guardOwnSchool()) return;
        const venue = DB.getVenues().find(v => v.id === school.venueId);
        const isRestricted = !!(venue && venue.restrictedMode);
        const start  = document.getElementById('ms-block-start').value;
        const end    = document.getElementById('ms-block-end').value || start;
        const reason = document.getElementById('ms-block-reason').value.trim();
        if (!start) { toast('Select a start date', 'error'); return; }
        const tsEl = document.getElementById('ms-block-time-start');
        const teEl = document.getElementById('ms-block-time-end');
        const timeStart = (isRestricted && tsEl) ? (tsEl.value || null) : null;
        const timeEnd   = (isRestricted && teEl) ? (teEl.value || null) : null;
        if (isRestricted && (!timeStart || !timeEnd)) { toast('Enter open time window (From time and To time)', 'error'); return; }
        DB.addClosure({ venueId: school.venueId, startDate: start, endDate: end, reason, courtIndex: '', timeStart, timeEnd, type: isRestricted ? 'open' : 'block' });
        toast(isRestricted ? 'Open window added ✓' : 'Blocked date added ✓', 'success');
        Calendar.refresh();
        _render();
      });
    }

    // Closures / open windows: delete
    container.querySelectorAll('.ms-closure-del').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!_guardOwnSchool()) return;
        DB.deleteClosure(btn.dataset.id).catch(console.warn);
        toast('Blocked date removed', 'success');
        Calendar.refresh();
        _render();
      });
    });

    // Team unavailability: add
    const sbAddBtn = document.getElementById('ms-sb-add');
    if (sbAddBtn) {
      sbAddBtn.addEventListener('click', () => {
        if (!_guardOwnSchool()) return;
        const start  = document.getElementById('ms-sb-start').value;
        const end    = document.getElementById('ms-sb-end').value || start;
        const reason = document.getElementById('ms-sb-reason').value.trim();
        if (!start) { toast('Select a start date', 'error'); return; }
        DB.addClosure({ schoolId: school.id, startDate: start, endDate: end, reason: reason || null, type: 'school_block' });
        toast('Unavailability date added ✓', 'success');
        _render();
      });
    }

    // Team unavailability: delete
    container.querySelectorAll('.ms-school-block-del').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!_guardOwnSchool()) return;
        DB.deleteClosure(btn.dataset.id).catch(console.warn);
        toast('Unavailability date removed', 'success');
        _render();
      });
    });

    // Organisers: add row
    const orgAddBtn = document.getElementById('ms-org-add');
    if (orgAddBtn) {
      orgAddBtn.addEventListener('click', () => {
        const list = document.getElementById('ms-org-list');
        const idx  = list.querySelectorAll('.ms-org-row').length;
        const row  = document.createElement('div');
        row.className = 'ms-org-row';
        row.dataset.orgIdx = idx;
        row.style.cssText = 'display:flex;gap:.5rem;align-items:center;margin-bottom:.4rem;flex-wrap:wrap';
        row.innerHTML = `
          <input class="ms-org-name" type="text" placeholder="Name" style="flex:1;min-width:120px" data-org="${idx}">
          <input class="ms-org-email" type="email" placeholder="Email" style="flex:1;min-width:140px" data-org="${idx}">
          <input class="ms-org-phone" type="tel" placeholder="Phone" style="flex:1;min-width:100px" data-org="${idx}">
          <button class="btn btn-xs btn-danger ms-org-del" data-org="${idx}" title="Remove">✕</button>`;
        row.querySelector('.ms-org-del').addEventListener('click', () => row.remove());
        list.appendChild(row);
      });
    }

    // Organisers: delete existing row
    container.querySelectorAll('.ms-org-del').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.ms-org-row').remove());
    });

    // Organisers: save
    const orgSaveBtn = document.getElementById('ms-org-save');
    if (orgSaveBtn) {
      orgSaveBtn.addEventListener('click', () => {
        if (!_guardOwnSchool()) return;
        const rows = document.querySelectorAll('#ms-org-list .ms-org-row');
        const organizers = [];
        rows.forEach(row => {
          const name  = row.querySelector('.ms-org-name')?.value.trim() || '';
          const email = row.querySelector('.ms-org-email')?.value.trim() || '';
          const phone = row.querySelector('.ms-org-phone')?.value.trim() || '';
          if (name || email) organizers.push({ name, email, phone });
        });
        DB.updateSchool({ ...school, organizers }).catch(console.warn);
        toast('Organisers saved ✓', 'success');
        _render();
      });
    }

    // If impersonating, load school notifications asynchronously
    if (_impersonateSchoolId) {
      NotificationService.renderSchoolNotifications(_impersonateSchoolId, 'schoolNotifList');
      const refreshBtn = document.getElementById('refreshSchoolNotifBtn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', () =>
          NotificationService.renderSchoolNotifications(_impersonateSchoolId, 'schoolNotifList')
        );
      }
    }

    // Score-entry listeners — auto-fill + button colour update.
    // Saving only happens when the "Submit Score" button is clicked so
    // the re-render never wipes the auto-filled partner value.
    container.querySelectorAll('.my-score-input').forEach(inp => {
      const _updateSubmitBtn = () => {
        const fid     = inp.dataset.fixture;
        const btn     = container.querySelector(`.ms-save-score-btn[data-fixture="${fid}"]`);
        if (!btn) return;
        const homeInp = container.querySelector(`.my-score-input[data-fixture="${fid}"][data-field="homeScore"]`);
        const awayInp = container.querySelector(`.my-score-input[data-fixture="${fid}"][data-field="awayScore"]`);
        if (!homeInp || !awayInp) return;
        // Compare current values against the last-saved values stamped on the button
        const savedHome    = btn.dataset.savedHome ?? '';
        const savedAway    = btn.dataset.savedAway ?? '';
        const alreadySaved = savedHome !== '' && savedAway !== '';
        const unchanged    = alreadySaved &&
                             homeInp.value === savedHome &&
                             awayInp.value === savedAway;
        const bothEmpty    = homeInp.value === '' && awayInp.value === '';
        // Green = matches saved; Orange = clearing saved scores; Blue = editing/new
        btn.disabled = false;
        if (unchanged) {
          btn.textContent = '✓ Submitted';
          btn.className   = 'btn btn-xs ms-save-score-btn btn-success';
        } else if (bothEmpty && alreadySaved) {
          btn.textContent = '🗑 Clear Scores';
          btn.className   = 'btn btn-xs ms-save-score-btn btn-warning';
        } else {
          btn.textContent = '📨 Submit Score';
          btn.className   = 'btn btn-xs ms-save-score-btn btn-primary';
        }
      };

      inp.addEventListener('input', () => {
        const league2     = DB.getLeagues().find(l => l.id === inp.dataset.league);
        const SCORE_TOTAL = (league2 && league2.scoreTotal) ? league2.scoreTotal : 67;
        const val         = parseInt(inp.value);
        if (!isNaN(val) && val >= 0) {
          const partnerField = inp.dataset.field === 'homeScore' ? 'awayScore' : 'homeScore';
          const partner = container.querySelector(
            `.my-score-input[data-fixture="${inp.dataset.fixture}"][data-field="${partnerField}"]`
          );
          if (partner) {
            const prevAuto   = parseInt(partner.dataset.autoVal);
            const partnerVal = parseInt(partner.value);
            if (partner.value === '' || (!isNaN(prevAuto) && partnerVal === prevAuto)) {
              const auto = SCORE_TOTAL - val;
              if (auto >= 0) { partner.value = auto; partner.dataset.autoVal = String(auto); }
            }
          }
        }
        _updateSubmitBtn();
      });
    });

    // Submit Score button — saves both scores atomically.
    // Blue while unsubmitted; green once both fields are filled.
    // Flashes "Score Submitted ✓" on success before re-rendering.
    container.querySelectorAll('.ms-save-score-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const lid     = btn.dataset.league;
        const fid     = btn.dataset.fixture;
        const homeInp = container.querySelector(`.my-score-input[data-fixture="${fid}"][data-field="homeScore"]`);
        const awayInp = container.querySelector(`.my-score-input[data-fixture="${fid}"][data-field="awayScore"]`);
        if (!homeInp || !awayInp) return;
        const homeEmpty = homeInp.value === '';
        const awayEmpty = awayInp.value === '';
        // Exactly one score filled — ambiguous, ask user to fix
        if (homeEmpty !== awayEmpty) {
          toast('Please enter both scores, or clear both to remove the result', 'error');
          return;
        }
        // Both filled → save scores; both empty → clear scores (save null/null)
        Leagues.saveScore(lid, fid, 'homeScore', homeInp.value);
        Leagues.saveScore(lid, fid, 'awayScore', awayInp.value);
        // Stamp the saved values so future edits can detect changes
        btn.dataset.savedHome = homeInp.value;
        btn.dataset.savedAway = awayInp.value;
        // Flash confirmation, then re-render (fixture moves back to Upcoming if cleared)
        const isClearing = homeEmpty && awayEmpty;
        btn.className   = `btn btn-xs ms-save-score-btn ${isClearing ? 'btn-warning' : 'btn-success'}`;
        btn.textContent = isClearing ? 'Scores Cleared ✓' : 'Score Submitted ✓';
        btn.disabled    = true;
        setTimeout(() => _render(), 800);
      });
    });

    // Score sheet button
    container.querySelectorAll('.ms-scoresheet-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Leagues.openScoreSheet(btn.dataset.lid, btn.dataset.fid);
      });
    });

    // Verify score listeners
    container.querySelectorAll('.ms-verify-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Leagues.verifyScore(btn.dataset.lid, btn.dataset.fid, btn.dataset.as, null, false);
        _render();
      });
    });

    // Request reschedule
    container.querySelectorAll('.ms-reschedule-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const lid      = btn.dataset.lid;
        const fid      = btn.dataset.fid;
        const oppId    = btn.dataset.oppId;
        const oppName  = btn.dataset.oppName;
        const date     = btn.dataset.date;
        const venue    = btn.dataset.venue;
        const dateStr  = date ? formatDate(date) : 'TBA';
        NotificationService.openContextModal({
          title: '📅 Request Reschedule',
          types: [{
            value: 'reschedule',
            label: 'Request Reschedule',
            subject: `Reschedule request – fixture on ${dateStr}`,
            body: `We would like to request a reschedule for the fixture at ${venue || 'TBA'} on ${dateStr}. Please advise on an alternative date.`,
            recipientLabel: `Sends to: ${oppName || 'opposition'} users + all admin users`,
            sendFn: async (title, body) => {
              if (oppId) await NotificationService.sendToSchool(oppId, { type: 'fixture_changed', title, body, leagueId: lid, fixtureId: fid });
              await NotificationService.sendToMasters({ type: 'fixture_changed', title, body, leagueId: lid, fixtureId: fid });
              _submitChangeRequest(lid, fid, 'reschedule', { note: body });
            },
          }],
        });
      });
    });

    // Send contextual notification (opposition / master)
    container.querySelectorAll('.ms-notif-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const leagueId     = btn.dataset.lid;
        const fixtureId    = btn.dataset.fid;
        const homeSchoolId = btn.dataset.home;
        const awaySchoolId = btn.dataset.away;
        const homeSchoolName = btn.dataset.hname;
        const awaySchoolName = btn.dataset.aname;
        const hasScore     = btn.dataset.hasScore === '1';
        const schoolId     = _activeSchoolId();
        const isHome       = schoolId === homeSchoolId;
        const oppSchoolId  = isHome ? awaySchoolId : homeSchoolId;
        const oppSchoolName = isHome ? awaySchoolName : homeSchoolName;
        const league       = DB.getLeagues().find(l => l.id === leagueId);
        const fixtureName  = `${homeSchoolName} vs ${awaySchoolName}`;

        const types = [
          {
            value:          'fixture_change_suggestion',
            label:          '📅 Suggest fixture change — send to master/admin',
            subject:        `Fixture change request: ${fixtureName}`,
            body:           `We would like to request a change for the fixture ${fixtureName}${league ? ' in ' + league.name : ''}. Please could we discuss an alternative date, time or venue?`,
            recipientLabel: '📬 Recipients: Master / Admin users',
            sendFn: async (title, body) => {
              await NotificationService.sendToMasters({
                type: 'fixture_changed', title, body, leagueId, fixtureId,
              });
            },
          },
          {
            value:          'general_master',
            label:          '💬 General message to master/admin',
            subject:        `Message re: ${fixtureName}`,
            body:           '',
            recipientLabel: '📬 Recipients: Master / Admin users',
            sendFn: async (title, body) => {
              await NotificationService.sendToMasters({
                type: 'general_message', title, body, leagueId, fixtureId,
              });
            },
          },
          {
            value:          'general_opposition',
            label:          `💬 General message to ${oppSchoolName}`,
            subject:        `Message from fixture opponent`,
            body:           '',
            recipientLabel: `📬 Recipients: Users of ${oppSchoolName}`,
            sendFn: async (title, body) => {
              await NotificationService.sendToSchool(oppSchoolId, {
                type: 'general_message', title, body, leagueId, fixtureId,
              });
            },
          },
        ];

        if (hasScore) {
          types.splice(1, 0, {
            value:          'score_verification',
            label:          `✅ Ask ${oppSchoolName} to verify score`,
            subject:        `Please verify: ${fixtureName}`,
            body:           `Could you please verify the score for ${fixtureName}? The result has been recorded and is awaiting your confirmation.`,
            recipientLabel: `📬 Recipients: Users of ${oppSchoolName}`,
            sendFn: async (title, body) => {
              await NotificationService.sendToSchool(oppSchoolId, {
                type: 'score_reminder', title, body, leagueId, fixtureId,
              });
            },
          });
        }

        NotificationService.openContextModal({
          title: `Notify — ${fixtureName}`,
          types,
        });
      });
    });

    // Request alternate venue
    container.querySelectorAll('.ms-altvenue-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _openAltVenueModal({
          lid:          btn.dataset.lid,
          fid:          btn.dataset.fid,
          date:         btn.dataset.date,
          currentVenue: btn.dataset.venue,
          oppId:        btn.dataset.oppId,
          oppName:      btn.dataset.oppName,
        });
      });
    });
  }

  // ── Venue availability helper ─────────────────────────────────
  // Returns each venue with how many courts are free on a given date.
  function _getVenueAvailability(date) {
    if (!date) return [];
    const usageMap = {}; // venueId → total courtsBooked on that date
    for (const league of DB.getLeagues()) {
      for (const f of (league.fixtures || [])) {
        if (!f.venueId || f.date !== date) continue;
        usageMap[f.venueId] = (usageMap[f.venueId] || 0) + (f.courtsBooked || 3);
      }
    }
    return DB.getVenues().map(v => {
      const courtsUsed  = usageMap[v.id] || 0;
      const totalCourts = v.courts || 0;
      // freeCount = null means capacity is unknown (courts not configured)
      const freeCount   = totalCourts > 0 ? totalCourts - courtsUsed : null;
      return { venue: v, totalCourts, courtsUsed, freeCount };
    });
  }

  // ── Alternative venue request modal ──────────────────────────
  function _openAltVenueModal({ lid, fid, date, currentVenue, oppId, oppName }) {
    // Remove stale modal if any
    document.getElementById('ms-altvenueModal')?.remove();

    const schools        = DB.getSchools();
    const mySchoolId     = _activeSchoolId();
    const mySchool       = schools.find(s => s.id === mySchoolId);
    const venueAvailList = _getVenueAvailability(date);

    // Build one row per venue that belongs to a school in the system.
    // Sort: most free courts first, then unknown capacity, then full/overbooked.
    const rows = venueAvailList
      .map(entry => {
        const hostSchool = schools.find(s => s.venueId === entry.venue.id);
        return { ...entry, hostSchool };
      })
      .filter(e => e.hostSchool && e.hostSchool.id !== mySchoolId) // exclude own venue
      .sort((a, b) => {
        const fa = a.freeCount === null ? 0 : a.freeCount;
        const fb = b.freeCount === null ? 0 : b.freeCount;
        return fb - fa; // most free courts first
      })
      .map(({ venue, totalCourts, courtsUsed, freeCount, hostSchool }) => {
        let icon, availText, disabled = '';
        if (freeCount === null) {
          icon      = '⚪';
          availText = 'Capacity not set — contact school to confirm';
        } else if (freeCount <= 0) {
          icon      = '🔴';
          availText = `Full — ${courtsUsed} court${courtsUsed !== 1 ? 's' : ''} booked of ${totalCourts}`;
          disabled  = ''; // still allow requesting — they may have flexibility
        } else if (freeCount === 1) {
          icon      = '🟡';
          availText = `1 of ${totalCourts} courts free`;
        } else {
          icon      = '🟢';
          availText = `${freeCount} of ${totalCourts} courts free`;
        }
        return `
          <label style="display:flex;align-items:flex-start;gap:.6rem;padding:.55rem .65rem;
                         border:1px solid var(--border,#e5e7eb);border-radius:8px;cursor:pointer;
                         margin-bottom:.4rem;transition:background .15s"
                 onmouseover="this.style.background='var(--surface2,#f8fafc)'"
                 onmouseout="this.style.background=''">
            <input type="radio" name="altVenueSchool" value="${esc(hostSchool.id)}"
              data-venue-id="${esc(venue.id)}" data-venue-name="${esc(venue.name)}"
              data-school-name="${esc(hostSchool.name)}"
              style="margin-top:.2rem;flex-shrink:0" ${disabled}>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:.9rem">${esc(venue.name)}</div>
              <div class="text-muted" style="font-size:.8rem">🏫 ${esc(hostSchool.name)}</div>
            </div>
            <span style="font-size:.82rem;white-space:nowrap;padding-top:.1rem">
              ${icon} ${availText}
            </span>
          </label>`;
      }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'ms-altvenueModal';
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:9999',
      'background:rgba(0,0,0,.45)',
      'display:flex;align-items:center;justify-content:center;padding:1rem',
    ].join(';');

    overlay.innerHTML = `
      <div style="background:var(--surface,#fff);border-radius:12px;max-width:500px;
                  width:100%;max-height:90vh;overflow-y:auto;padding:1.5rem;
                  box-shadow:0 8px 32px rgba(0,0,0,.22)">
        <h3 style="margin:0 0 .2rem">🏟 Request Alternative Venue</h3>
        <p class="text-muted" style="margin:0 0 1rem;font-size:.85rem">
          Fixture at <strong>${esc(currentVenue || 'current venue')}</strong>
          on <strong>${date ? formatDate(date) : '—'}</strong>
          vs <strong>${esc(oppName || 'opposition')}</strong>
        </p>

        <p style="font-size:.83rem;margin:0 0 .6rem">
          Select a school to request hosting. Availability is based on fixtures
          already scheduled at each venue on this date.
        </p>

        <div id="ms-avVenueList">
          ${rows || '<p class="text-muted" style="font-size:.85rem">No other venues found in the system.</p>'}
        </div>

        <div style="margin-top:.9rem">
          <label style="font-weight:600;display:block;margin-bottom:.3rem;font-size:.88rem">
            Message to the host school <span class="text-muted" style="font-weight:400">(optional)</span>
          </label>
          <textarea id="ms-avNote" rows="3"
            placeholder="e.g. Our venue is double-booked on this date. Could you host this match?"
            style="width:100%;box-sizing:border-box;resize:vertical;padding:.5rem;
                   border:1px solid var(--border,#e5e7eb);border-radius:6px;
                   font-family:inherit;font-size:.88rem"></textarea>
        </div>

        <p class="text-muted" style="font-size:.78rem;margin:.6rem 0 0">
          ℹ️ The notification goes directly to the selected school's contacts.
          No admin approval is required — the two schools can arrange this directly.
        </p>

        <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1rem">
          <button class="btn btn-secondary" id="ms-avCancel">Cancel</button>
          <button class="btn btn-primary"   id="ms-avSend">Send Request 📨</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Close on backdrop click or Cancel
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('ms-avCancel').onclick = () => overlay.remove();

    document.getElementById('ms-avSend').onclick = async () => {
      const selected = overlay.querySelector('input[name="altVenueSchool"]:checked');
      if (!selected) { toast('Please select a venue to request', 'error'); return; }

      const targetSchoolId   = selected.value;
      const targetSchoolName = selected.dataset.schoolName;
      const targetVenueId    = selected.dataset.venueId;
      const targetVenueName  = selected.dataset.venueName;
      const note             = document.getElementById('ms-avNote').value.trim();
      const myName           = mySchool ? mySchool.name : 'A school';
      const dateStr          = date ? formatDate(date) : '—';

      const notifTitle = `🏟 Venue Hosting Request — ${dateStr}`;
      const notifBody  = `${myName} is requesting to use ${targetVenueName} as an alternative venue `
        + `for their match vs ${oppName || 'their opposition'} on ${dateStr}.\n\n`
        + (note ? note + '\n\n' : '')
        + `Please reply if you can accommodate this fixture.`;

      const sendBtn = document.getElementById('ms-avSend');
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';

      try {
        await NotificationService.sendToSchool(targetSchoolId, {
          type:      'venue_hosting_request',
          title:     notifTitle,
          body:      notifBody,
          leagueId:  lid,
          fixtureId: fid,
        });

        _submitChangeRequest(lid, fid, 'venue', {
          requestedVenueId: targetVenueId,
          note: note || `Requested hosting from ${targetSchoolName} (${targetVenueName})`,
        });

        toast(`Request sent to ${targetSchoolName} ✓`, 'success');
        overlay.remove();
      } catch (err) {
        console.error('[MySchool] alt venue request failed:', err);
        toast('Failed to send — please try again', 'error');
        sendBtn.disabled = false; sendBtn.textContent = 'Send Request 📨';
      }
    };
  }

  /** Submit a fixture change request (reschedule or alt-venue) on behalf of the school. */
  function _submitChangeRequest(leagueId, fixtureId, type, data) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;
    const profile = Auth.getProfile();
    fixture.changeRequest = {
      type,
      requestedDate:    data.requestedDate    || null,
      requestedTime:    data.requestedTime    || null,
      requestedVenueId: data.requestedVenueId || null,
      note:             data.note             || '',
      requestedBy:      profile ? profile.uid  : null,
      requestedByName:  profile ? (profile.displayName || profile.email) : 'School',
      requestedAt:      new Date().toISOString(),
    };
    DB.updateLeague(league);
    DB.writeAudit('change_requested', 'league',
      `Change request (${type}) submitted for ${fixture.homeSchoolName} vs ${fixture.awaySchoolName}`,
      leagueId, league.name);
    toast('Change request submitted ✓', 'success');
    _render();
  }

  // ── per-league section ───────────────────────────────────────
  function _leagueSection(league, schoolId) {
    const myParts          = _parts(league).filter(p => p.schoolId === schoolId);
    const myParticipantIds = myParts.map(p => p.participantId);

    const myFixtures = (league.fixtures || []).filter(f => {
      const hk = f.homeParticipantId || f.homeSchoolId;
      const ak = f.awayParticipantId || f.awaySchoolId;
      return myParticipantIds.includes(hk) || myParticipantIds.includes(ak);
    });

    // Pre-compute clash IDs for this render
    const clashedIds = new Set();
    for (const { a, b } of DB.detectFixtureClashes()) {
      if (a.leagueId === league.id || b.leagueId === league.id) {
        clashedIds.add(a.fixture.id);
        clashedIds.add(b.fixture.id);
      }
    }

    // A fixture is only "played" (→ Recent Results) when BOTH scores are valid numbers.
    // Guards against null, undefined, and NaN (NaN arises when "null" string is
    // rendered into an input value and parseInt("null") is called on it).
    const _isValidScore = v => v !== null && v !== undefined && !isNaN(v);
    const _bothScores   = f => _isValidScore(f.homeScore) && _isValidScore(f.awayScore);

    const allUpcoming = myFixtures
      .filter(f => !_bothScores(f))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const upcoming = _fixtureView === 'next' ? allUpcoming.slice(0, 1) : allUpcoming;

    const recent = _fixtureView === 'next' ? [] : myFixtures
      .filter(_bothScores)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 5);

    const myStandings = (league.standings || []).filter(r => myParticipantIds.includes(r.participantId));
    const totalTeams  = (league.standings || []).length;

    // Home/Away counts per participant across all my fixtures
    const haCounts = {};
    myParticipantIds.forEach(id => { haCounts[id] = { home: 0, away: 0 }; });
    myFixtures.forEach(f => {
      const hk = f.homeParticipantId || f.homeSchoolId;
      const ak = f.awayParticipantId || f.awaySchoolId;
      if (haCounts[hk] !== undefined) haCounts[hk].home++;
      if (haCounts[ak] !== undefined) haCounts[ak].away++;
    });

    const DAYS     = ['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'];
    const dayLabel = league.playingDay !== undefined ? ` · ${DAYS[league.playingDay]}` : '';

    let html = `<div class="myschool-league card">
      <div class="card-header">
        <div>
          <div class="card-title">🏆 ${esc(league.name)}</div>
          <div class="text-muted">${esc(league.division || '')}${dayLabel}${league.matchTime ? ' · ' + league.matchTime : ''}</div>
        </div>
      </div>
      <div class="card-body">`;

    // Standings + H/A balance summary
    if (myStandings.length > 0) {
      html += `<div class="myschool-standings">`;
      myStandings.forEach(row => {
        const pos      = (league.standings || []).findIndex(r => r.participantId === row.participantId) + 1;
        const posClass = pos === 1 ? 'badge-green' : pos === 2 ? 'badge-amber' : 'badge-gray';
        const ha       = haCounts[row.participantId] || { home: 0, away: 0 };
        const diff     = Math.abs(ha.home - ha.away);
        const haBadge  = diff > 1
          ? `<span class="score-unverified-badge" title="Home/away imbalance — contact admin to recalculate">🏠${ha.home} ✈️${ha.away} ⚠️</span>`
          : `<span class="text-muted" style="font-size:.78rem" title="Home / Away games">🏠${ha.home} ✈️${ha.away}</span>`;
        html += `<div class="myschool-standing-row">
          <span class="badge ${posClass}">#${pos} / ${totalTeams}</span>
          <strong>${esc(row.name)}</strong>
          <span class="text-muted">${row.played}P · ${row.won}W · ${row.drawn}D · ${row.lost}L</span>
          <span class="myschool-pts">${row.points} pts</span>
          ${haBadge}
        </div>`;
      });
      html += `</div>`;
    }

    if (upcoming.length > 0) {
      html += `<div class="myschool-section-label">📅 Upcoming Fixtures</div>`;
      html += upcoming.map(f => _fixtureRow(f, league.id, myParticipantIds, true, clashedIds)).join('');
    }

    if (recent.length > 0) {
      html += `<div class="myschool-section-label">📊 Recent Results</div>`;
      // canEdit=true — score stays editable until master verifies (locked inside _fixtureRow)
      html += recent.map(f => _fixtureRow(f, league.id, myParticipantIds, true, clashedIds)).join('');
    }

    if (upcoming.length === 0 && recent.length === 0) {
      html += `<p class="text-muted" style="margin:.5rem 0">No fixtures scheduled yet.</p>`;
    }

    html += `</div></div>`;
    return html;
  }

  // ── fixture row ──────────────────────────────────────────────
  function _fixtureRow(f, leagueId, myParticipantIds, canEdit, clashedIds) {
    const hasScore = f.homeScore !== null && f.homeScore !== undefined;
    const homeKey  = f.homeParticipantId || f.homeSchoolId;
    const isHome   = myParticipantIds.includes(homeKey);

    const schools    = DB.getSchools();
    const homeSchool = schools.find(s => s.id === f.homeSchoolId);
    const awaySchool = schools.find(s => s.id === f.awaySchoolId);
    const hColor     = homeSchool ? homeSchool.color : '#666';
    const aColor     = awaySchool ? awaySchool.color : '#666';

    // ── Score ──
    const isLocked = !!(f.masterVerified);   // admin closed this score — no more edits
    let scoreHtml;
    if (canEdit && Auth.isLoggedIn() && !isLocked) {
      // Use separate guards for each score — don't assume awayScore is set
      // just because homeScore is. Rendering null/undefined as a value attribute
      // produces the literal string "null" which confuses parseInt later.
      const homeVal = (f.homeScore !== null && f.homeScore !== undefined && !isNaN(f.homeScore)) ? f.homeScore : '';
      const awayVal = (f.awayScore !== null && f.awayScore !== undefined && !isNaN(f.awayScore)) ? f.awayScore : '';
      const alreadySaved = homeVal !== '' && awayVal !== '';
      scoreHtml = `
        <input class="my-score-input score-input" type="number" min="0" max="99"
          value="${homeVal}"
          data-league="${leagueId}" data-fixture="${f.id}" data-field="homeScore"
          style="width:54px;text-align:center">
        <span style="color:var(--neutral);margin:0 .2rem">—</span>
        <input class="my-score-input score-input" type="number" min="0" max="99"
          value="${awayVal}"
          data-league="${leagueId}" data-fixture="${f.id}" data-field="awayScore"
          style="width:54px;text-align:center">
        <button class="btn btn-xs ${alreadySaved ? 'btn-success' : 'btn-primary'} ms-save-score-btn"
          data-league="${leagueId}" data-fixture="${f.id}"
          data-saved-home="${homeVal}" data-saved-away="${awayVal}"
          title="Submit both scores">${alreadySaved ? '✓ Submitted' : '📨 Submit Score'}</button>`;
    } else if (hasScore) {
      const outcome   = isHome
        ? (f.homeScore > f.awayScore ? 'W' : f.homeScore < f.awayScore ? 'L' : 'D')
        : (f.awayScore > f.homeScore ? 'W' : f.awayScore < f.homeScore ? 'L' : 'D');
      const outcClass = outcome === 'W' ? 'badge-green' : outcome === 'L' ? 'badge-red' : 'badge-gray';
      scoreHtml = `<span class="badge ${outcClass}" style="margin-right:.25rem">${outcome}</span><strong>${f.homeScore} — ${f.awayScore}</strong>`;
    } else {
      scoreHtml = `<span class="text-muted">vs</span>`;
    }

    // ── Verification badge ──
    let verifyHtml = '';
    if (hasScore) {
      const verified = !!(f.masterVerified || (f.homeTeamVerified && f.awayTeamVerified));
      if (verified) {
        verifyHtml = `<div class="score-verified">✓ Score Verified</div>`;
      } else {
        let status = '⚠️ Unverified';
        if (f.homeTeamVerified)  status = '⏳ Awaiting away team';
        if (f.awayTeamVerified)  status = '⏳ Awaiting home team';
        let verifyBtn = '';
        if (Auth.isLoggedIn()) {
          if (isHome && !f.homeTeamVerified) {
            verifyBtn = `<button class="btn btn-xs btn-primary ms-verify-btn"
              data-lid="${leagueId}" data-fid="${f.id}" data-as="home">Verify ✓</button>`;
          } else if (!isHome && !f.awayTeamVerified) {
            verifyBtn = `<button class="btn btn-xs btn-primary ms-verify-btn"
              data-lid="${leagueId}" data-fid="${f.id}" data-as="away">Verify ✓</button>`;
          }
        }
        if (Auth.isAdmin()) {
          verifyBtn += `<button class="btn btn-xs btn-secondary ms-verify-btn"
            data-lid="${leagueId}" data-fid="${f.id}" data-as="master" title="Verify on behalf of both teams">Master ✓</button>`;
        }
        verifyHtml = `<div class="score-unverified"><span class="score-unverified-badge">${status}</span>${verifyBtn}</div>`;
      }
    }

    // ── Clash / change-request badge ──
    let clashHtml = '';
    const isClash = clashedIds && clashedIds.has(f.id);
    if (isClash) {
      if (f.clashOkayed) {
        clashHtml = `<div class="clash-okayed-badge">✓ Clash acknowledged${f.clashReason ? ': ' + esc(f.clashReason) : ''}</div>`;
      } else {
        const hasRequest = !!f.changeRequest;
        const oppSchoolId   = isHome ? f.awaySchoolId   : f.homeSchoolId;
        const oppSchoolName = isHome ? f.awaySchoolName  : f.homeSchoolName;
        let requestBtns = '';
        if (!hasRequest && Auth.isLoggedIn()) {
          requestBtns = `<button class="btn btn-xs btn-secondary ms-reschedule-btn"
            data-lid="${leagueId}" data-fid="${esc(f.id)}"
            data-opp-id="${esc(oppSchoolId || '')}" data-opp-name="${esc(oppSchoolName || '')}"
            data-date="${esc(f.date || '')}" data-venue="${esc(f.venueName || '')}">📅 Request Reschedule</button>
            <button class="btn btn-xs btn-secondary ms-altvenue-btn"
            data-lid="${leagueId}" data-fid="${esc(f.id)}"
            data-opp-id="${esc(oppSchoolId || '')}" data-opp-name="${esc(oppSchoolName || '')}"
            data-date="${esc(f.date || '')}" data-venue="${esc(f.venueName || '')}">🏟 Request Host Venue</button>`;
        }
        clashHtml = `<div class="fixture-clash-badge">⚠️ Potential venue clash on this day ${requestBtns}</div>`;
        if (hasRequest) {
          const cr    = f.changeRequest;
          const vName = cr.requestedVenueId
            ? ((DB.getVenues().find(v => v.id === cr.requestedVenueId) || {}).name || cr.requestedVenueId)
            : null;
          const detail = cr.type === 'venue'
            ? `Host venue requested: ${vName || 'pending'}`
            : `Reschedule: ${cr.requestedDate || '?'}${cr.requestedTime ? ' ' + cr.requestedTime : ''}`;
          clashHtml += `<div class="change-request-badge">
            📨 Your request: ${detail}${cr.note ? ` — <em>${esc(cr.note)}</em>` : ''}
            <span class="text-muted">(awaiting admin approval)</span>
          </div>`;
        }
      }
    }

    // ── Notification button (logged-in non-impersonating school users) ──
    const notifBtnHtml = Auth.isLoggedIn() && !Auth.isAdmin()
      ? `<div class="ms-notif-section">
           <button class="btn btn-xs btn-secondary ms-notif-btn"
             data-lid="${leagueId}" data-fid="${esc(f.id)}"
             data-home="${esc(f.homeSchoolId || '')}" data-away="${esc(f.awaySchoolId || '')}"
             data-hname="${esc(f.homeSchoolName || '')}" data-aname="${esc(f.awaySchoolName || '')}"
             data-has-score="${hasScore ? '1' : '0'}">🔔 Notify</button>
         </div>`
      : '';

    // ── Score sheet button ──
    const hasScoreSheet  = !!(f.scoreSheet && (
      (f.scoreSheet.singles || []).some(r => r.homePlayer || r.visitorPlayer || r.homeGames !== null) ||
      (f.scoreSheet.doubles || []).some(r => r.homePlayer || r.visitorPlayer || r.homeGames !== null)
    ));
    const scoreSheetBtn  = Auth.isLoggedIn()
      ? `<span class="text-muted" style="font-size:.78rem;align-self:center">Full Scoresheet:</span>
         <button class="btn btn-xs ${hasScoreSheet ? 'btn-secondary' : 'btn-outline'} ms-scoresheet-btn"
           data-lid="${leagueId}" data-fid="${esc(f.id)}"
           title="${hasScoreSheet ? 'View / edit score sheet' : 'Fill in full score sheet'}">
           📋 ${hasScoreSheet ? 'Score Sheet ✓' : 'Score Sheet'}
         </button>`
      : (hasScoreSheet ? `<span class="badge badge-gray" style="font-size:.72rem">📋 Score sheet on file</span>` : '');

    return `<div class="myschool-fixture ${isHome ? 'home-fixture' : 'away-fixture'}${isClash && !f.clashOkayed ? ' ms-fixture-clash' : ''}">
      <div class="fixture-meta">
        <span class="fixture-date">${f.date ? formatDate(f.date) : '—'}</span>
        ${f.timeSlot ? `<span class="text-muted">${f.timeSlot}</span>` : ''}
        <span class="text-muted">📍 ${esc(f.venueName || 'TBA')}</span>
      </div>
      <div class="fixture-score-row">
        <span class="fixture-team${isHome ? ' my-team' : ''}">
          <span style="color:${hColor}">●</span> ${esc(f.homeSchoolName)}
        </span>
        <span class="fixture-score">${scoreHtml}</span>
        <span class="fixture-team${!isHome ? ' my-team' : ''}">
          <span style="color:${aColor}">●</span> ${esc(f.awaySchoolName)}
        </span>
      </div>
      ${verifyHtml}
      ${clashHtml}
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.3rem">
        ${scoreSheetBtn}
        ${notifBtnHtml ? `<button class="btn btn-xs btn-secondary ms-notif-btn"
             data-lid="${leagueId}" data-fid="${esc(f.id)}"
             data-home="${esc(f.homeSchoolId || '')}" data-away="${esc(f.awaySchoolId || '')}"
             data-hname="${esc(f.homeSchoolName || '')}" data-aname="${esc(f.awaySchoolName || '')}"
             data-has-score="${hasScore ? '1' : '0'}">🔔 Notify</button>` : ''}
      </div>
    </div>`;
  }

  // ── My School Settings section ────────────────────────────────
  function _settingsSection(school, venue) {
    const restricted = !!(venue && venue.restrictedMode);
    const closures = venue
      ? DB.getClosures()
          .filter(c => c.venueId === venue.id && !c.courtIndex && (c.type === (restricted ? 'open' : 'block') || (!c.type && !restricted)))
          .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
      : [];

    const schoolBlocks = DB.getClosures()
      .filter(c => c.schoolId === school.id && c.type === 'school_block')
      .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

    const orgs = (school.organizers && school.organizers.length)
      ? school.organizers
      : (school.contact ? [{ name: school.contact, email: school.email || '', phone: school.phone || '' }] : [{ name: '', email: '', phone: '' }]);

    const orgRows = orgs.map((o, i) => `
      <div class="ms-org-row" data-org-idx="${i}" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.4rem;flex-wrap:wrap">
        <input class="ms-org-name" type="text" placeholder="Name" value="${esc(o.name || '')}"
          style="flex:1;min-width:120px" data-org="${i}">
        <input class="ms-org-email" type="email" placeholder="Email" value="${esc(o.email || '')}"
          style="flex:1;min-width:140px" data-org="${i}">
        <input class="ms-org-phone" type="tel" placeholder="Phone" value="${esc(o.phone || '')}"
          style="flex:1;min-width:100px" data-org="${i}">
        <button class="btn btn-xs btn-danger ms-org-del" data-org="${i}" title="Remove organiser">✕</button>
      </div>`).join('');

    const closureRows = closures.map(c => `
      <div class="ms-closure-row" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.3rem;flex-wrap:wrap">
        <span style="font-size:.85rem">📅 ${formatDate(c.startDate)}${c.endDate && c.endDate !== c.startDate ? ' → ' + formatDate(c.endDate) : ''}</span>
        ${c.timeStart && c.timeEnd ? `<span class="text-muted" style="font-size:.8rem">⏰ ${c.timeStart}–${c.timeEnd}</span>` : ''}
        ${c.reason ? `<span class="text-muted" style="font-size:.8rem">${esc(c.reason)}</span>` : ''}
        <button class="btn btn-xs btn-danger ms-closure-del" data-id="${c.id}" title="Remove">✕</button>
      </div>`).join('');

    return `
      <div class="card" id="ms-settings-card" style="margin-top:1.25rem">
        <div class="card-header" id="ms-settings-toggle"
          style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none"
          title="Click to expand / collapse settings">
          <div class="card-title" style="margin:0">⚙️ My School Settings</div>
          <span id="ms-settings-chevron" style="font-size:1rem;transition:transform .2s">▼</span>
        </div>
        <div class="card-body" id="ms-settings-body"
          style="display:none;flex-direction:column;gap:1rem">

          <!-- Courts available -->
          <div>
            <label style="font-weight:600;display:block;margin-bottom:.4rem">🎾 Courts available at venue</label>
            <div style="display:flex;gap:.5rem;align-items:center">
              <input id="ms-courts-input" type="number" min="1" max="20"
                value="${venue ? (venue.courts || '') : ''}"
                placeholder="${venue ? '' : 'No venue linked'}"
                ${venue ? '' : 'disabled'}
                style="width:80px">
              <button class="btn btn-sm btn-primary" id="ms-courts-save"
                ${venue ? '' : 'disabled'}>Save</button>
              ${!venue ? `<span class="text-muted" style="font-size:.8rem">Link a venue in Admin first</span>` : ''}
            </div>
          </div>

          <!-- Availability mode + closures / open windows -->
          <div>
            ${venue ? `
            <!-- Restricted mode toggle -->
            <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem">
              <label class="toggle-switch">
                <input type="checkbox" id="ms-restricted-toggle" ${restricted ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
              <div>
                <span style="font-weight:600">Restricted mode</span>
                <div class="text-muted" style="font-size:.78rem">
                  ${restricted
                    ? 'All dates blocked — only listed open windows are bookable'
                    : 'All dates open — only listed blocked dates are unavailable'}
                </div>
              </div>
            </div>` : ''}

            <label style="font-weight:600;display:block;margin-bottom:.4rem">
              ${restricted ? '✅ Open windows (all other dates are blocked)' : '🚫 Blocked dates (courts unavailable)'}
            </label>
            <div id="ms-closures-list">${closureRows ||
              `<span class="text-muted" style="font-size:.85rem">${restricted ? 'No open windows — venue is fully blocked.' : 'No blocked dates.'}</span>`}
            </div>

            ${venue ? `
            <div style="display:flex;gap:.5rem;align-items:center;margin-top:.5rem;flex-wrap:wrap">
              <input type="date" id="ms-block-start" style="flex:1;min-width:130px">
              <span class="text-muted">to</span>
              <input type="date" id="ms-block-end" style="flex:1;min-width:130px">
              ${restricted ? `
              <input type="time" id="ms-block-time-start" style="flex:1;min-width:110px">
              <span class="text-muted">–</span>
              <input type="time" id="ms-block-time-end" style="flex:1;min-width:110px">` : ''}
              <input type="text" id="ms-block-reason" placeholder="${restricted ? 'Label (e.g. Match day)' : 'Reason (optional)'}" style="flex:2;min-width:140px">
              <button class="btn btn-sm btn-secondary" id="ms-block-add">+ ${restricted ? 'Add open window' : 'Add block'}</button>
            </div>` : `<span class="text-muted" style="font-size:.8rem">Link a venue in Admin to manage dates.</span>`}
          </div>

          <!-- Organisers -->
          <div>
            <label style="font-weight:600;display:block;margin-bottom:.4rem">👤 Organisers &amp; contact details</label>
            <div id="ms-org-list">${orgRows}</div>
            <div style="display:flex;gap:.5rem;margin-top:.4rem">
              <button class="btn btn-sm btn-secondary" id="ms-org-add">+ Add organiser</button>
              <button class="btn btn-sm btn-primary" id="ms-org-save">Save organisers</button>
            </div>
          </div>

          <!-- Team unavailability -->
          <div>
            <label style="font-weight:600;display:block;margin-bottom:.2rem">🚫 Team unavailability</label>
            <p class="text-muted" style="font-size:.8rem;margin:0 0 .5rem">
              Dates when the team cannot play at all — home <em>and</em> away fixtures will be rescheduled to after the last regular round when fixtures are regenerated.
            </p>
            <div id="ms-school-blocks-list">${
              schoolBlocks.length
                ? schoolBlocks.map(c => `
                  <div class="ms-closure-row" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.3rem;flex-wrap:wrap">
                    <span style="font-size:.85rem">📅 ${formatDate(c.startDate)}${c.endDate && c.endDate !== c.startDate ? ' → ' + formatDate(c.endDate) : ''}</span>
                    ${c.reason ? `<span class="text-muted" style="font-size:.8rem">${esc(c.reason)}</span>` : ''}
                    <button class="btn btn-xs btn-danger ms-school-block-del" data-id="${c.id}" title="Remove">✕</button>
                  </div>`).join('')
                : `<span class="text-muted" style="font-size:.85rem">No unavailability dates.</span>`
            }</div>
            <div style="display:flex;gap:.5rem;align-items:center;margin-top:.5rem;flex-wrap:wrap">
              <input type="date" id="ms-sb-start" style="flex:1;min-width:130px">
              <span class="text-muted">to</span>
              <input type="date" id="ms-sb-end" style="flex:1;min-width:130px">
              <input type="text" id="ms-sb-reason" placeholder="Reason (e.g. School tour)" style="flex:2;min-width:140px">
              <button class="btn btn-sm btn-secondary" id="ms-sb-add">+ Add</button>
            </div>
          </div>

        </div>
      </div>`;
  }

  // Public helper: navigate to My School and expand the settings card.
  // Called from other views (e.g. My Venue ⚙️ Settings shortcut).
  function openSettings() {
    // Switch to the My School view directly (no event-dispatch race condition).
    const view = document.getElementById('view-myschool');
    if (view && view.classList.contains('hidden')) {
      // navigate() is a global defined in app.js — switches views synchronously.
      if (typeof navigate === 'function') navigate('myschool');
      // Re-render content synchronously now that the view is visible.
      _render();
    }
    // Expand the settings card. Use requestAnimationFrame so the browser has
    // painted the freshly rendered DOM before we try to scroll to the card.
    requestAnimationFrame(() => {
      const body    = document.getElementById('ms-settings-body');
      const chevron = document.getElementById('ms-settings-chevron');
      const card    = document.getElementById('ms-settings-card');
      if (body)    body.style.display         = 'flex';
      if (chevron) chevron.style.transform    = 'rotate(180deg)';
      if (card)    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  return { init, refresh, impersonate, stopImpersonation, isImpersonating, getActiveSchoolId, openSettings };
})();
