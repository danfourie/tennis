/**
 * admin.js — Administration panel with sub-tab navigation.
 * Sub-tabs: Overview · Leagues · Tournaments · Venues · Schools · Users · Settings
 */

const Admin = (() => {

  // ── Active sub-tab tracking ───────────────────────────────────
  let _activeTab = 'overview';

  /** Format an ISO timestamp as "22 Mar 2026, 14:30" */
  function _fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) +
           ', ' + d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  }

  // Validate a phone field that may contain multiple numbers separated by / or ,
  // Each individual number (stripped of spaces) must be 10 digits starting with 0.
  function _validPhone(val) {
    if (!val) return true; // empty is fine
    return val.split(/[\/,]/).every(part => /^0\d{9}$/.test(part.trim()));
  }

  // ── Search helper ─────────────────────────────────────────────
  /**
   * Wire up a search input (once) to filter a list container.
   * itemSelector: CSS selector for filterable items within the container.
   */
  function _initSearch(inputId, listSelector, itemSelector) {
    const inp = document.getElementById(inputId);
    if (!inp || inp.dataset.searchBound) return;
    inp.dataset.searchBound = '1';
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase().trim();
      document.querySelectorAll(`${listSelector} ${itemSelector}`).forEach(el => {
        el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  /** Re-apply current search value after a re-render (so filter stays active). */
  function _applySearch(inputId, listSelector, itemSelector) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    const q = inp.value.toLowerCase().trim();
    if (!q) return;
    document.querySelectorAll(`${listSelector} ${itemSelector}`).forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  function init() {
    // Sub-tab click handlers
    document.querySelectorAll('.admin-subtab').forEach(btn => {
      btn.addEventListener('click', () => _switchTab(btn.dataset.subtab));
    });

    // Venue buttons
    document.getElementById('addVenueBtn').addEventListener('click', () => openVenueModal());
    document.getElementById('venueSubmitBtn').addEventListener('click', saveVenue);

    // School buttons
    document.getElementById('addSchoolBtn').addEventListener('click', () => openSchoolModal());
    document.getElementById('schoolSubmitBtn').addEventListener('click', saveSchool);

    // Closure buttons
    document.getElementById('addClosureBtn').addEventListener('click', () => openClosureModal());
    document.getElementById('closureSubmitBtn').addEventListener('click', saveClosure);
    document.getElementById('closureVenue').addEventListener('change', () => { updateClosureCourtList(); _updateClosureModalTitle(); });

    // League admin buttons (in admin tab — different IDs from public view)
    document.getElementById('addLeagueBtnAdmin').addEventListener('click', () => Leagues.openLeagueModal());

    // Tournament admin buttons
    document.getElementById('addTournamentBtnAdmin').addEventListener('click', () => Tournaments.openTournamentModal());

    // Password change
    document.getElementById('changePasswordBtn').addEventListener('click', changePassword);

    // Notification composer — send button
    document.getElementById('sendNotifBtn').addEventListener('click', () => {
      const title    = (document.getElementById('notifTitle').value || '').trim();
      const body     = (document.getElementById('notifBody').value  || '').trim();
      const selVal   = document.getElementById('notifRecipientGroup').value || 'all';
      const [groupType, groupId] = selVal.includes(':') ? selVal.split(':') : [selVal, null];
      NotificationService.sendGeneral(title, body, groupType, groupId);
    });

    // Wire up static search inputs (once; survives re-renders)
    _initSearch('venuesSearch',          '#venuesList',            '.admin-list-item');
    _initSearch('schoolsSearch',         '#schoolsList',           '.admin-list-item');
    _initSearch('usersSearch',           '#usersList',             '.admin-list-item');
    _initSearch('adminLeaguesSearch',    '#adminLeaguesList',      '.admin-module-item');
    _initSearch('adminTournamentsSearch','#adminTournamentsList',  '.admin-module-item');

    render();
  }

  function _switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll('.admin-subtab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.subtab === tab);
    });
    document.querySelectorAll('.admin-tab-panel').forEach(panel => {
      panel.classList.toggle('hidden', panel.id !== `subtab-${tab}`);
      panel.classList.toggle('active', panel.id === `subtab-${tab}`);
    });
    // Lazy-render heavy tabs when first opened
    if (tab === 'overview')      { renderPendingResults(); renderPendingBookings(); if (typeof Leagues !== 'undefined') Leagues.renderPendingEntries(); if (!_twilioLoaded) renderTwilioUsage(); }
    if (tab === 'leagues')       Leagues.renderAdmin();
    if (tab === 'tournaments')   Tournaments.renderAdmin();
    if (tab === 'users')         renderUsers();
    if (tab === 'settings')      { renderGlobalSettings(); renderAuditLog(); }
    if (tab === 'notifications') NotificationService.renderComposer();
  }

  function refresh() { render(); }

  function render() {
    renderVenues();
    renderSchools();
    renderClosures();
    renderPendingResults();
    renderPendingBookings();
    if (typeof Leagues !== 'undefined') Leagues.renderPendingEntries();
    // Only re-render active heavy tabs to avoid unnecessary work
    if (_activeTab === 'leagues')       Leagues.renderAdmin();
    if (_activeTab === 'tournaments')   Tournaments.renderAdmin();
    if (_activeTab === 'users')         renderUsers();
    if (_activeTab === 'settings')      { renderGlobalSettings(); renderAuditLog(); }
    if (_activeTab === 'notifications') NotificationService.renderComposer();
  }

  // ════════════════════════════════════════════════════════════
  // TWILIO USAGE / BALANCE
  // ════════════════════════════════════════════════════════════
  let _twilioLoading  = false;
  let _twilioLoaded   = false;   // auto-fetch once on first overview visit

  async function renderTwilioUsage() {
    const panel   = document.getElementById('twilioUsagePanel');
    const btn     = document.getElementById('twilioRefreshBtn');
    if (!panel || _twilioLoading) return;

    _twilioLoading = true;
    if (btn) { btn.disabled = true; btn.textContent = '↻ Loading…'; }
    panel.innerHTML = '<span class="text-muted" style="font-size:.85rem">Loading…</span>';

    try {
      const fn   = firebase.functions().httpsCallable('getTwilioUsage');
      const res  = await fn();
      const d    = res.data;
      _twilioLoaded = true;

      const bal     = d.balance !== null ? parseFloat(d.balance) : null;
      const now     = new Date();
      const month   = now.toLocaleString('default', { month: 'long', year: 'numeric' });

      // Balance colour: green ≥ 10, orange 3–10, red < 3
      let balColour = '#16a34a', balIcon = '🟢';
      if (bal !== null) {
        if (bal < 3)  { balColour = '#dc2626'; balIcon = '🔴'; }
        else if (bal < 10) { balColour = '#d97706'; balIcon = '🟡'; }
      }

      const balHtml = bal !== null
        ? `<div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.35rem;">
             <span style="font-size:1rem">${balIcon}</span>
             <span style="font-weight:600;font-size:1.05rem;color:${balColour}">$${bal.toFixed(2)} ${d.balanceCurrency}</span>
             <span class="text-muted" style="font-size:.8rem">account balance</span>
           </div>`
        : `<div class="text-muted" style="font-size:.85rem;margin-bottom:.35rem;">Balance unavailable</div>`;

      panel.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:1.5rem;align-items:flex-start;">
          <div>
            ${balHtml}
            <div style="font-size:.85rem;color:var(--text-muted);margin-top:.1rem">
              💬 <strong>${d.count}</strong> WhatsApp message${d.count !== 1 ? 's' : ''} sent in ${month}
              &nbsp;·&nbsp; cost: <strong>$${d.cost} ${d.currency}</strong>
            </div>
          </div>
        </div>
        <div class="text-muted" style="font-size:.75rem;margin-top:.5rem">
          Last checked: ${new Date().toLocaleTimeString()}
          ${bal !== null && bal < 5 ? ' &nbsp;⚠️ <strong style="color:#d97706">Top up recommended</strong>' : ''}
        </div>`;

    } catch (err) {
      panel.innerHTML = `<span class="text-muted" style="font-size:.85rem">Could not load Twilio data — ${err.message}</span>`;
    } finally {
      _twilioLoading = false;
      if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
    }
  }

  // Wire refresh button directly — scripts run after DOM is ready (bottom of body)
  const _twilioBtn = document.getElementById('twilioRefreshBtn');
  if (_twilioBtn) _twilioBtn.addEventListener('click', renderTwilioUsage);

  // ════════════════════════════════════════════════════════════
  // PENDING RESULTS (no score entered, or score not yet master/dual-verified)
  // ════════════════════════════════════════════════════════════
  function renderPendingResults() {
    const el = document.getElementById('pendingResultsList');
    if (!el) return;

    const today = new Date().toISOString().slice(0, 10);
    const noScore   = [];  // past fixtures with no score at all
    const unverified = []; // past fixtures with a score but not yet verified

    DB.getLeagues().forEach(league => {
      (league.fixtures || []).forEach(f => {
        if (!f.date) return;
        const hasScore   = f.homeScore !== null && f.homeScore !== undefined;
        const isVerified = !!(f.masterVerified || (f.homeTeamVerified && f.awayTeamVerified));
        // Unverified scores show regardless of date (scores can be entered early)
        if (hasScore && !isVerified) {
          unverified.push({ fixture: f, league });
        } else if (!hasScore && f.date < today) {
          // No score: only flag past fixtures (future fixtures haven't been played yet)
          noScore.push({ fixture: f, league });
        }
      });
    });

    // Most-recent first within each group
    const sortByDate = (a, b) => b.fixture.date.localeCompare(a.fixture.date);
    noScore.sort(sortByDate);
    unverified.sort(sortByDate);

    if (noScore.length === 0 && unverified.length === 0) {
      el.innerHTML = `<p class="text-muted">All fixtures are up to date ✓</p>`;
      return;
    }

    const _row = ({ fixture: f, league }, status) => {
      const homeSchool = DB.getSchools().find(s => s.id === f.homeSchoolId);
      const awaySchool = DB.getSchools().find(s => s.id === f.awaySchoolId);
      const hColor = homeSchool ? homeSchool.color : '#666';
      const aColor = awaySchool ? awaySchool.color : '#666';
      const scoreText = status === 'unverified'
        ? `<span class="text-muted" style="font-size:.8rem">${f.homeScore} — ${f.awayScore}</span>`
        : '';
      const badge = status === 'unverified'
        ? `<span class="badge" style="background:#fef9c3;color:#854d0e;font-size:.7rem">Unverified</span>`
        : `<span class="badge" style="background:#fee2e2;color:#991b1b;font-size:.7rem">No score</span>`;
      const notifyTitle  = status === 'unverified' ? 'Please verify match result' : 'Please submit match result';
      const notifyBody   = status === 'unverified'
        ? `The score for ${f.homeSchoolName} vs ${f.awaySchoolName} on ${formatDate(f.date)} (${f.homeScore}–${f.awayScore}) has not been verified yet. Please log in to confirm.`
        : `The score for ${f.homeSchoolName} vs ${f.awaySchoolName} on ${formatDate(f.date)} has not been recorded yet. Please log in and enter the result.`;
      return `<div class="admin-list-item">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
            <span class="badge badge-gray">${esc(league.name)}${league.division ? ' · ' + esc(league.division) : ''}</span>
            <span class="text-muted" style="font-size:.82rem">📅 ${f.date ? formatDate(f.date) : '—'}</span>
            ${badge}
          </div>
          <div style="margin-top:.2rem">
            <span style="color:${hColor}">●</span> ${esc(f.homeSchoolName)}
            <span class="text-muted" style="margin:0 .3rem">vs</span>
            <span style="color:${aColor}">●</span> ${esc(f.awaySchoolName)}
            ${scoreText ? ' &nbsp;' + scoreText : ''}
          </div>
        </div>
        <div class="item-actions">
          <button class="btn btn-xs btn-secondary" data-pr-view-league="${league.id}" data-pr-view-fixture="${f.id}">🔍 View</button>
          <button class="btn btn-xs btn-warning"
            data-pr-home="${f.homeSchoolId}"
            data-pr-away="${f.awaySchoolId}"
            data-pr-league="${league.id}"
            data-pr-fixture="${f.id}"
            data-pr-home-team="${esc(f.homeSchoolName || '')}"
            data-pr-away-team="${esc(f.awaySchoolName || '')}"
            data-pr-date="${f.date || ''}"
            data-pr-notify-title="${esc(notifyTitle)}"
            data-pr-notify-body="${esc(notifyBody)}">🔔 Notify</button>
        </div>
      </div>`;
    };

    let html = '<div class="admin-list">';
    if (noScore.length > 0) {
      html += noScore.map(item => _row(item, 'no-score')).join('');
    }
    if (unverified.length > 0) {
      if (noScore.length > 0) html += `<div style="border-top:1px solid var(--border);margin:.25rem 0"></div>`;
      html += unverified.map(item => _row(item, 'unverified')).join('');
    }
    html += '</div>';
    el.innerHTML = html;

    el.querySelectorAll('[data-pr-view-league]').forEach(btn => {
      btn.addEventListener('click', () => {
        _switchTab('leagues');
        if (typeof Leagues !== 'undefined') Leagues.openLeagueDetail(btn.dataset.prViewLeague, true, true, btn.dataset.prViewFixture || null);
      });
    });

    el.querySelectorAll('[data-pr-home]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const homeId    = btn.dataset.prHome;
        const awayId    = btn.dataset.prAway;
        const leagueId  = btn.dataset.prLeague;
        const fixtureId = btn.dataset.prFixture;
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          await NotificationService.sendToSchoolGroup([homeId, awayId], {
            type:         'score_reminder',
            title:        btn.dataset.prNotifyTitle,
            body:         btn.dataset.prNotifyBody,
            leagueId,
            fixtureId,
            homeTeam:     btn.dataset.prHomeTeam     || '',
            awayTeam:     btn.dataset.prAwayTeam     || '',
            date:         btn.dataset.prDate         || '',
            homeSchoolId: homeId,
            awaySchoolId: awayId,
          });
          toast('Reminder sent ✓', 'success');
          btn.textContent = '✓ Sent';
        } catch (err) {
          console.error('[Admin] pending result notify error:', err);
          btn.disabled = false; btn.textContent = '🔔 Notify';
          toast('Failed to send notification', 'error');
        }
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // PENDING BOOKING REQUESTS
  // ════════════════════════════════════════════════════════════
  function renderPendingBookings() {
    const el = document.getElementById('pendingList');
    if (!el) return;

    const pending = DB.getPendingBookings();
    if (pending.length === 0) {
      el.innerHTML = `<p class="text-muted">No pending requests.</p>`;
      return;
    }

    el.innerHTML = `<div class="admin-list">` +
      pending.map(b => {
        const venue = DB.getVenues().find(v => v.id === b.venueId);
        return `<div class="admin-list-item">
          <div>
            <strong>${esc(b.label || b.type || 'Booking')}</strong>
            <div class="text-muted">
              ${venue ? esc(venue.name) : '?'} · Court ${(b.courtIndex || 0) + 1}
              · ${b.date ? formatDate(b.date) : '?'} · ${b.timeSlot || '?'}
            </div>
            <div class="text-muted">Requested by: <em>${esc(b.requestedByName || 'Unknown')}</em></div>
            ${b.notes ? `<div class="text-muted">${esc(b.notes)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-primary" data-approve="${b.id}">Approve</button>
            <button class="btn btn-xs btn-danger"  data-reject="${b.id}">Reject</button>
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', () => {
        const booking = DB.getBookings().find(b => b.id === btn.dataset.approve);
        DB.approveBooking(btn.dataset.approve);
        DB.writeAudit(
          'booking_approved', 'booking',
          `Approved request by ${booking ? esc(booking.requestedByName || 'user') : 'user'}: ${booking ? esc(booking.label || '') : ''}`,
          btn.dataset.approve, booking ? booking.label : ''
        );
        Calendar.refresh();
        render();
        toast('Booking approved ✓', 'success');
      });
    });

    el.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', () => {
        const booking = DB.getBookings().find(b => b.id === btn.dataset.reject);
        DB.rejectBooking(btn.dataset.reject);
        DB.writeAudit(
          'booking_rejected', 'booking',
          `Rejected request by ${booking ? esc(booking.requestedByName || 'user') : 'user'}: ${booking ? esc(booking.label || '') : ''}`,
          btn.dataset.reject, booking ? booking.label : ''
        );
        Calendar.refresh();
        render();
        toast('Request rejected');
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // USERS MANAGEMENT
  // ════════════════════════════════════════════════════════════
  let _userRoleFilter   = 'all';
  let _userSchoolFilter = '';

  function _applyUserFilters() {
    const q = (document.getElementById('usersSearch')?.value || '').toLowerCase().trim();
    document.querySelectorAll('#usersList .admin-list-item').forEach(item => {
      const roleOk   = _userRoleFilter === 'all' || item.dataset.role === _userRoleFilter;
      const schoolOk = !_userSchoolFilter
                    || (_userSchoolFilter === '__none__' ? item.dataset.school === '' : item.dataset.school === _userSchoolFilter);
      const textOk   = !q || item.textContent.toLowerCase().includes(q);
      item.style.display = (roleOk && schoolOk && textOk) ? '' : 'none';
    });
  }

  async function renderUsers() {
    const el = document.getElementById('usersList');
    if (!el) return;

    el.innerHTML = `<p class="text-muted">Loading users…</p>`;
    const rawUsers = await DB.loadUsers();
    // Sort: master first, then admin, then user; A-Z within each group
    const roleOrder = { master: 0, admin: 1, user: 2 };
    const users = [...rawUsers].sort((a, b) => {
      const ro = (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9);
      if (ro !== 0) return ro;
      return (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '');
    });

    // Update count badge
    const countEl = document.getElementById('usersCount');
    if (countEl) countEl.textContent = users.length;

    const schools = DB.getSchools();
    const venues  = DB.getVenues();

    // Populate school filter dropdown (preserve current selection)
    const schoolSel = document.getElementById('usersSchoolFilter');
    if (schoolSel) {
      const prev = schoolSel.value;
      schoolSel.innerHTML = `<option value="">🏫 All Schools</option>` +
        `<option value="__none__">— No school</option>` +
        schools.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
      schoolSel.value = prev;
      schoolSel.onchange = () => {
        _userSchoolFilter = schoolSel.value;
        _applyUserFilters();
      };
    }

    // Wire role filter buttons
    document.querySelectorAll('.role-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.role === _userRoleFilter);
      btn.onclick = () => {
        _userRoleFilter = btn.dataset.role;
        document.querySelectorAll('.role-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.role === _userRoleFilter));
        _applyUserFilters();
      };
    });

    // Reset search field on every render so all users show by default
    const searchInp = document.getElementById('usersSearch');
    if (searchInp) { searchInp.value = ''; searchInp.oninput = _applyUserFilters; }

    if (users.length === 0) {
      el.innerHTML = `<p class="text-muted">No registered users yet.</p>`;
      return;
    }

    const currentUid = Auth.getUser() ? Auth.getUser().uid : null;

    el.innerHTML = `<div class="admin-list">` +
      users.map(u => {
        const school    = schools.find(s => s.id === u.schoolId);
        const schoolKey = u.schoolId || '';
        const isSelf    = u.uid === currentUid;
        const roleIcon  = u.role === 'master' ? '🔑' : u.role === 'admin' ? '🛡️' : '👤';

        const loginHistoryHtml = (u.loginLog && u.loginLog.length > 0)
          ? `<details style="margin-top:.3rem">
               <summary style="font-size:.74rem;color:var(--primary);cursor:pointer;user-select:none">
                 🕒 Login history (${u.loginLog.length})
               </summary>
               <div style="padding:.3rem 0 .1rem .75rem;border-left:2px solid var(--border);margin-top:.25rem">
                 ${u.loginLog.map((ts, i) =>
                   `<div style="font-size:.74rem;color:var(--text-muted);padding:.1rem 0">
                      ${i === 0 ? '<strong>' : ''}${_fmtDateTime(ts)}${i === 0 ? '</strong> <em style="font-size:.7rem">(latest)</em>' : ''}
                    </div>`
                 ).join('')}
               </div>
             </details>`
          : '';

        return `<div class="admin-list-item" data-role="${esc(u.role || 'user')}" data-school="${esc(schoolKey)}">
          <div>
            <strong>${roleIcon} ${esc(u.displayName || u.email)}</strong>
            ${isSelf ? '<span class="badge badge-gray" style="font-size:.7rem;margin-left:.3rem">You</span>' : ''}
            <div class="text-muted">${esc(u.email)}</div>
            <div class="text-muted">
              <span class="role-badge ${u.role === 'master' ? 'master' : u.role === 'admin' ? 'admin' : 'user'}">${u.role}</span>
              ${school ? ` · <span style="color:${school.color}">●</span> ${esc(school.name)}` : ''}
              ${u.createdAt ? ` · Registered: ${_fmtDateTime(u.createdAt)}` : ''}
            </div>
            ${u.lastLoginAt
              ? `<div class="text-muted" style="font-size:.78rem;margin-top:.1rem">
                   🟢 Last login: <strong>${_fmtDateTime(u.lastLoginAt)}</strong>
                 </div>`
              : '<div class="text-muted" style="font-size:.78rem;margin-top:.1rem">🔘 No login recorded yet</div>'}
            ${loginHistoryHtml}
            ${venues.length > 0 ? `
            <div style="margin-top:.4rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span style="font-size:.74rem;color:var(--text-muted);white-space:nowrap">📍 Extra venues:</span>
              <select class="venue-multiselect" data-user-uid="${u.uid}" multiple
                style="font-size:.73rem;padding:.2rem .3rem;border-radius:6px;border:1.5px solid var(--border,#e2e8f0);background:var(--surface,#fff);min-width:140px;max-width:260px;height:auto">
                ${venues.map(v => `
                  <option value="${esc(v.id)}" ${(u.managedVenueIds || []).includes(v.id) ? 'selected' : ''}>
                    ${esc(v.name)}
                  </option>`).join('')}
              </select>
            </div>` : ''}
          </div>
          <div class="item-actions">
            <label style="font-size:.75rem;color:var(--text-muted);margin-right:.25rem">Role:</label>
            <select class="role-select" data-user-uid="${u.uid}" data-current-role="${u.role}" style="padding:.2rem .4rem;border-radius:6px;border:1.5px solid var(--border);font-size:.8rem">
              <option value="user"  ${u.role === 'user'   ? 'selected' : ''}>User</option>
              <option value="admin" ${u.role === 'admin'  ? 'selected' : ''}>Admin</option>
              <option value="master"${u.role === 'master' ? 'selected' : ''}>Master</option>
            </select>
            <label style="font-size:.75rem;color:var(--text-muted);margin-right:.25rem;margin-left:.5rem">School:</label>
            <select class="school-select" data-user-uid="${u.uid}" style="padding:.2rem .4rem;border-radius:6px;border:1.5px solid var(--border);font-size:.8rem">
              <option value="">— None —</option>
              ${schools.map(s => `<option value="${s.id}" ${u.schoolId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>
            ${!isSelf ? `<button class="btn btn-xs btn-danger" data-user-delete="${u.uid}">Remove</button>` : ''}
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('.role-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const userUid  = sel.dataset.userUid;
        const oldRole  = sel.dataset.currentRole;
        const newRole  = sel.value;
        const user     = DB.getUsers().find(u => u.uid === userUid);
        if (!user || oldRole === newRole) return;
        DB.updateUser({ ...user, role: newRole });
        DB.writeAudit(
          'user_role_changed', 'user',
          `Role changed for ${esc(user.displayName || user.email)}: ${oldRole} → ${newRole}`,
          userUid, user.displayName || user.email
        );
        sel.dataset.currentRole = newRole;
        toast(`Role updated to "${newRole}"`, 'success');
        renderUsers();
      });
    });

    el.querySelectorAll('.school-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const userUid   = sel.dataset.userUid;
        const newSchool = sel.value || null;
        const user      = DB.getUsers().find(u => u.uid === userUid);
        if (!user) return;
        DB.updateUser({ ...user, schoolId: newSchool });
        DB.writeAudit(
          'user_school_changed', 'user',
          `School changed for ${esc(user.displayName || user.email)}: ${newSchool || 'none'}`,
          userUid, user.displayName || user.email
        );
        toast(`School updated`, 'success');
        renderUsers();
      });
    });

    // ── Managed Venues (extra venue access) ──────────────────────────────
    el.querySelectorAll('.venue-multiselect').forEach(sel => {
      sel.addEventListener('change', () => {
        const userUid = sel.dataset.userUid;
        const user    = DB.getUsers().find(u => u.uid === userUid);
        if (!user) return;
        const updated = Array.from(sel.selectedOptions).map(o => o.value);
        DB.updateUser({ ...user, managedVenueIds: updated });
        DB.writeAudit(
          'user_venue_access_changed', 'user',
          `Extra venue access updated for ${esc(user.displayName || user.email)}: ${updated.map(id => DB.getVenues().find(v => v.id === id)?.name || id).join(', ') || 'none'}`,
          userUid, user.displayName || user.email
        );
        toast('Venue access updated ✓', 'success');
      });
    });

    el.querySelectorAll('[data-user-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userUid = btn.dataset.userDelete;
        const user    = DB.getUsers().find(u => u.uid === userUid);
        if (!confirm(`Remove ${user ? (user.displayName || user.email) : 'this user'}? They will lose access.`)) return;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
          // Await the Firestore delete before re-fetching, otherwise loadUsers()
          // returns the old snapshot (race condition) and the user reappears.
          await DB.deleteUserProfile(userUid);
          DB.writeAudit(
            'user_removed', 'user',
            `User profile removed: ${user ? esc(user.displayName || user.email) : userUid}`,
            userUid, user ? (user.displayName || user.email) : userUid
          );
          toast('User removed');
          renderUsers();
        } catch (err) {
          console.error('[Admin] delete user failed:', err);
          toast('Could not remove user — permission denied', 'error');
          btn.disabled = false;
          btn.textContent = 'Remove';
        }
      });
    });

    // Re-apply all active filters after re-render
    _applyUserFilters();
  }

  // ════════════════════════════════════════════════════════════
  // GLOBAL SETTINGS
  // ════════════════════════════════════════════════════════════
  function renderGlobalSettings() {
    const panel = document.getElementById('globalSettingsPanel');
    if (!panel) return;
    const settings = DB.getSettings();
    const tourEnabled = settings.tournamentPageEnabled === true; // default OFF
    const waEnabled   = settings.whatsappEnabled !== false;      // default ON
    panel.innerHTML = `
      <div class="feature-toggle-row">
        <label class="toggle-switch" title="Toggle Tournament page visibility for all users">
          <input type="checkbox" id="tournamentPageToggle" ${tourEnabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span>Tournament Page Enabled
          <span class="badge ${tourEnabled ? 'badge-green' : 'badge-red'}" style="margin-left:.3rem">${tourEnabled ? 'On' : 'Off'}</span>
        </span>
      </div>
      <p class="text-muted" style="font-size:.85rem;margin-top:.1rem">When disabled, the Tournaments tab is hidden for all users in real time.</p>

      <div class="feature-toggle-row" style="margin-top:1rem">
        <label class="toggle-switch" title="Toggle WhatsApp notifications for all users">
          <input type="checkbox" id="whatsappToggle" ${waEnabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span>WhatsApp Notifications Enabled
          <span class="badge ${waEnabled ? 'badge-green' : 'badge-red'}" style="margin-left:.3rem">${waEnabled ? 'On' : 'Off'}</span>
        </span>
      </div>
      <p class="text-muted" style="font-size:.85rem;margin-top:.1rem">When disabled, no WhatsApp messages are sent via Twilio regardless of user opt-in.</p>`;

    document.getElementById('tournamentPageToggle')?.addEventListener('change', e => {
      const newEnabled = e.target.checked;
      DB.saveSettings({ ...DB.getSettings(), tournamentPageEnabled: newEnabled });
      DB.writeAudit(
        'setting_changed', 'admin',
        `Tournament page ${newEnabled ? 'enabled' : 'disabled'}`,
        'settings/global', 'Tournament Page'
      );
      toast(`Tournament page ${newEnabled ? 'enabled ✓' : 'disabled ✓'}`, 'success');
      renderGlobalSettings();
    });

    document.getElementById('whatsappToggle')?.addEventListener('change', e => {
      const newEnabled = e.target.checked;
      DB.saveSettings({ ...DB.getSettings(), whatsappEnabled: newEnabled });
      DB.writeAudit(
        'setting_changed', 'admin',
        `WhatsApp notifications ${newEnabled ? 'enabled' : 'disabled'}`,
        'settings/global', 'WhatsApp'
      );
      toast(`WhatsApp ${newEnabled ? 'enabled ✓' : 'disabled ✓'}`, 'success');
      renderGlobalSettings();
    });
  }

  // ════════════════════════════════════════════════════════════
  // AUDIT LOG
  // ════════════════════════════════════════════════════════════
  function renderAuditLog() {
    const el = document.getElementById('auditList');
    if (!el) return;

    // Default date range: last 30 days
    const todayStr = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    el.innerHTML = `
      <div class="audit-filters" style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end;margin-bottom:.75rem">
        <div>
          <label class="form-label" style="font-size:.8rem;margin-bottom:2px">From</label>
          <input type="date" id="auditFrom" class="form-control form-control-sm" value="${monthAgo}" style="width:140px">
        </div>
        <div>
          <label class="form-label" style="font-size:.8rem;margin-bottom:2px">To</label>
          <input type="date" id="auditTo" class="form-control form-control-sm" value="${todayStr}" style="width:140px">
        </div>
        <div>
          <label class="form-label" style="font-size:.8rem;margin-bottom:2px">Category</label>
          <select id="auditCat" class="form-control form-control-sm" style="width:130px">
            <option value="">All categories</option>
            <option value="booking">📅 Bookings</option>
            <option value="user">👤 Users</option>
            <option value="admin">⚙️ Admin</option>
            <option value="league">🏆 Leagues</option>
            <option value="tournament">🏅 Tournaments</option>
            <option value="notification">🔔 Notifications</option>
          </select>
        </div>
        <button class="btn btn-sm btn-primary" id="auditApplyBtn">Apply</button>
      </div>
      <div id="auditResults"><p class="text-muted">Loading…</p></div>`;

    async function loadResults(loadMore = false) {
      const fromVal = document.getElementById('auditFrom')?.value;
      const toVal   = document.getElementById('auditTo')?.value;
      const catVal  = document.getElementById('auditCat')?.value;
      const resultsEl = document.getElementById('auditResults');
      if (!resultsEl) return;

      resultsEl.innerHTML = `<p class="text-muted">Loading…</p>`;

      // Convert date strings to ISO timestamps
      const from     = fromVal ? fromVal + 'T00:00:00.000Z' : undefined;
      const to       = toVal   ? toVal   + 'T23:59:59.999Z' : undefined;
      const pageSize = 50;

      const entries = await DB.loadAuditLog({ from, to, category: catVal || undefined, limit: pageSize });

      if (entries.length === 0) {
        resultsEl.innerHTML = `<p class="text-muted">No entries found for this filter.</p>`;
        return;
      }

      const catIcon = { booking: '📅', league: '🏆', tournament: '🏅', admin: '⚙️', user: '👤', notification: '🔔', fixture: '📋' };

      resultsEl.innerHTML = `
        <div class="audit-table-wrap">
          <table class="audit-table">
            <thead><tr><th>When</th><th>Who</th><th>What happened</th></tr></thead>
            <tbody>` +
        entries.map(e => {
          const when = e.at
            ? new Date(e.at).toLocaleString('en-ZA', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
            : '—';
          const icon = catIcon[e.category] || '📋';
          return `<tr>
            <td class="audit-when">${when}</td>
            <td class="audit-who">${esc(e.by || '?')}</td>
            <td>${icon} ${esc(e.description || e.action || '?')}</td>
          </tr>`;
        }).join('') +
        `</tbody></table>
        </div>
        <div style="display:flex;gap:.5rem;margin-top:.5rem;align-items:center">
          <span class="text-muted" style="font-size:.82rem">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
          ${entries.length === pageSize
            ? `<button class="btn btn-xs btn-secondary" id="auditLoadMoreBtn">Load more ↓</button>`
            : ''}
        </div>`;

      document.getElementById('auditLoadMoreBtn')?.addEventListener('click', async () => {
        const lastEntry = entries[entries.length - 1];
        const moreEl = document.getElementById('auditResults');
        const tbody  = moreEl?.querySelector('tbody');
        const footer = moreEl?.querySelector('div[style]');
        if (!tbody || !lastEntry) return;

        const more = await DB.loadAuditLog({
          from: fromVal ? fromVal + 'T00:00:00.000Z' : undefined,
          to:   lastEntry.at,   // use last entry's timestamp as new ceiling
          category: catVal || undefined,
          limit: pageSize + 1,  // +1 to detect if there are more
        });
        // Remove the duplicate first entry (same as lastEntry)
        const newEntries = more.filter(e => e.at !== lastEntry.at || e.id !== lastEntry.id).slice(0, pageSize);
        newEntries.forEach(e => {
          const when = e.at
            ? new Date(e.at).toLocaleString('en-ZA', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
            : '—';
          const icon = catIcon[e.category] || '📋';
          const row = document.createElement('tr');
          row.innerHTML = `
            <td class="audit-when">${when}</td>
            <td class="audit-who">${esc(e.by || '?')}</td>
            <td>${icon} ${esc(e.description || e.action || '?')}</td>`;
          tbody.appendChild(row);
        });
        if (newEntries.length < pageSize) footer.querySelector('#auditLoadMoreBtn')?.remove();
      });
    }

    document.getElementById('auditApplyBtn').addEventListener('click', () => loadResults());
    loadResults();
  }

  // ════════════════════════════════════════════════════════════
  // VENUES
  function _syncSchoolOrganizersToVenues() {
    const schools = DB.getSchools();
    let count = 0;
    DB.getVenues().forEach(v => {
      const vNameLc = v.name.toLowerCase();
      const linked = schools.filter(s =>
        s.organizers && s.organizers.length &&
        (s.venueId === v.id || (!s.venueId && s.name.toLowerCase() === vNameLc))
      );
      if (!linked.length) return;
      const existing = v.contacts || [];
      const keys = new Set(existing.map(c => `${(c.email || '').toLowerCase()}|${c.phone || ''}`));
      const toAdd = [];
      linked.forEach(s => s.organizers.forEach(o => {
        const key = `${(o.email || '').toLowerCase()}|${o.phone || ''}`;
        if (!keys.has(key)) { toAdd.push(o); keys.add(key); }
      }));
      if (toAdd.length) {
        DB.updateVenue({ ...v, contacts: [...existing, ...toAdd] }).catch(console.warn);
        count += toAdd.length;
      }
    });
    if (count > 0) {
      toast(`🔗 ${count} school contact${count > 1 ? 's' : ''} synced to home venues`, 'success');
      render();
    }
  }

  // ════════════════════════════════════════════════════════════
  function renderVenues() {
    _syncSchoolOrganizersToVenues();
    const el = document.getElementById('venuesList');
    const venues = DB.getVenues(); // already sorted alphabetically by getter
    if (venues.length === 0) {
      el.innerHTML = `<p class="text-muted">No venues yet.</p>`;
      return;
    }
    el.innerHTML = `<div class="admin-list">` +
      venues.map(v => `
        <div class="admin-list-item">
          <div>
            <strong>${esc(v.name)}</strong>
            <div class="text-muted">${v.courts || 0} courts${v.address ? ' · ' + esc(v.address) : ''}</div>
            ${(v.contacts && v.contacts.length
                ? v.contacts.map(c => `<div class="text-muted">👤 ${esc(c.name)}${c.email ? ' · ' + esc(c.email) : ''}${c.phone ? ' · ' + esc(c.phone) : ''}</div>`).join('')
                : (v.email || v.phone || v.contact)
                    ? `<div class="text-muted">👤 ${v.contact ? esc(v.contact) : ''}${v.contact && v.email ? ' · ' : ''}${v.email ? esc(v.email) : ''}${v.phone ? ' · ' + esc(v.phone) : ''}</div>`
                    : '')}
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-secondary" data-venue-edit="${v.id}">Edit</button>
            <button class="btn btn-xs btn-danger"    data-venue-delete="${v.id}">Del</button>
          </div>
        </div>`).join('') +
      `</div>`;

    el.querySelectorAll('[data-venue-edit]').forEach(btn => {
      btn.addEventListener('click', () => openVenueModal(btn.dataset.venueEdit));
    });
    el.querySelectorAll('[data-venue-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteVenue(btn.dataset.venueDelete));
    });
    _applySearch('venuesSearch', '#venuesList', '.admin-list-item');
  }

  function openVenueModal(id) {
    const v = id ? DB.getVenues().find(x => x.id === id) : null;
    document.getElementById('venueModalTitle').textContent    = v ? 'Edit Venue' : 'Add Venue';
    document.getElementById('venueName').value                = v ? v.name : '';
    document.getElementById('venueAddress').value             = v ? (v.address || '') : '';
    document.getElementById('venueEmail').value               = v ? (v.email  || '') : '';
    document.getElementById('venueRestrictedMode').checked    = !!(v && v.restrictedMode);
    document.getElementById('venuePhone').value            = v ? (v.phone  || '') : '';
    document.getElementById('venueCourtCount').value       = v ? (v.courts || 4) : 4;
    document.getElementById('venueEditId').value           = v ? v.id : '';
    // Populate contacts
    const conEl = document.getElementById('venueContacts');
    const conSeed = (v && v.contacts && v.contacts.length)
      ? v.contacts
      : (v && (v.email || v.phone || v.contact) ? [{ name: v.contact || '', email: v.email || '', phone: v.phone || '' }] : []);
    conEl.innerHTML = conSeed.map(_contactRow).join('');
    document.getElementById('addContactBtn').onclick = () => {
      conEl.insertAdjacentHTML('beforeend', _contactRow({ name: '', email: '', phone: '' }));
      _wireContactRemoveButtons();
    };
    _wireContactRemoveButtons();
    Modal.open('venueModal');
  }

  async function saveVenue() {
    const name  = document.getElementById('venueName').value.trim();
    const phone = document.getElementById('venuePhone').value.trim();
    if (!name) { toast('Venue name required', 'error'); return; }
    if (!_validPhone(phone)) {
      toast('Each phone number must be 10 digits starting with 0 (separate multiple numbers with /)', 'error'); return;
    }
    const id = document.getElementById('venueEditId').value;
    const contacts = [...document.querySelectorAll('#venueContacts .contact-row')].map(row => ({
      name:  row.querySelector('.con-name').value.trim(),
      email: row.querySelector('.con-email').value.trim(),
      phone: row.querySelector('.con-phone').value.trim(),
    })).filter(c => c.name || c.email);
    const venue = {
      id: id || uid(),
      name,
      address:        document.getElementById('venueAddress').value.trim(),
      email:          document.getElementById('venueEmail').value.trim(),
      phone,
      courts:         parseInt(document.getElementById('venueCourtCount').value) || 4,
      restrictedMode: document.getElementById('venueRestrictedMode').checked,
      contacts,
    };
    Modal.close('venueModal');
    if (id) {
      const savePromise = DB.updateVenue(venue);
      DB.writeAudit('venue_updated', 'admin', `Venue updated: ${name}`, id, name);
      render(); Calendar.refresh(); Leagues.refresh(); Tournaments.refresh();
      try {
        await savePromise;
        toast('Venue updated', 'success');
      } catch (e) {
        console.error('Venue update failed:', e);
        toast('Save failed — ' + (e.message || 'permission denied'), 'error');
        render(); Calendar.refresh();
      }
    } else {
      render(); Calendar.refresh(); Leagues.refresh(); Tournaments.refresh();
      try {
        await DB.addVenue(venue);
        DB.writeAudit('venue_added', 'admin', `Venue added: ${name}`, venue.id, name);
        toast('Venue added', 'success');
        render();
      } catch (e) {
        console.error('Venue add failed:', e);
        toast('Save failed — ' + (e.message || 'permission denied'), 'error');
        render(); Calendar.refresh();
      }
    }
  }

  async function deleteVenue(id) {
    const venue = DB.getVenues().find(v => v.id === id);
    if (!confirm('Delete this venue? Bookings at this venue will remain but venue reference will be lost.')) return;
    DB.writeAudit('venue_deleted', 'admin', `Venue deleted: ${venue ? venue.name : id}`, id, venue ? venue.name : id);
    const deletePromise = DB.deleteVenue(id);
    render(); Calendar.refresh();
    try {
      await deletePromise;
      toast('Venue deleted', 'success');
    } catch (e) {
      console.error('Venue delete failed:', e);
      toast('Delete failed — ' + (e.message || 'permission denied'), 'error');
      render(); Calendar.refresh();
    }
  }

  // ════════════════════════════════════════════════════════════
  // SCHOOLS
  // ════════════════════════════════════════════════════════════
  /** Get all leagues that include a given schoolId (any participant). */
  function _schoolLeagues(schoolId) {
    return DB.getLeagues().filter(l => {
      const parts = l.participants && l.participants.length > 0
        ? l.participants
        : (l.schoolIds || []).map(id => ({ participantId: id, schoolId: id, teamSuffix: '' }));
      return parts.some(p => p.schoolId === schoolId);
    });
  }

  // ── Organiser row helpers ─────────────────────────────────────────────────
  function _contactRow(c) {
  return `<div class="contact-row" style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:.35rem;align-items:center;margin-bottom:.15rem">
    <input class="form-control form-control-sm con-name"  placeholder="Name"  value="${esc(c.name  || '')}">
    <input class="form-control form-control-sm con-email" placeholder="Email" value="${esc(c.email || '')}" type="email">
    <input class="form-control form-control-sm con-phone" placeholder="Phone" value="${esc(c.phone || '')}">
    <button type="button" class="btn btn-xs btn-danger con-remove" title="Remove">✕</button>
  </div>`;
}

function _wireContactRemoveButtons() {
  document.querySelectorAll('#venueContacts .con-remove').forEach(btn => {
    btn.onclick = () => btn.closest('.contact-row').remove();
  });
}

function _orgRow(o) {
    return `<div class="organizer-row" style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:.35rem;align-items:center;margin-bottom:.15rem">
      <input class="form-control form-control-sm org-name"  placeholder="Name"  value="${esc(o.name  || '')}">
      <input class="form-control form-control-sm org-email" placeholder="Email" value="${esc(o.email || '')}" type="email">
      <input class="form-control form-control-sm org-phone" placeholder="Phone" value="${esc(o.phone || '')}">
      <button type="button" class="btn btn-xs btn-danger org-remove" title="Remove">✕</button>
    </div>`;
  }

  function _wireOrgRemoveButtons() {
    document.querySelectorAll('#schoolOrganizers .org-remove').forEach(btn => {
      btn.onclick = () => btn.closest('.organizer-row').remove();
    });
  }

  // ── Auto-link schools to venues with matching names ───────────────────────
  function _autoLinkSchoolVenues() {
    const venues = DB.getVenues();
    let count = 0;
    DB.getSchools().forEach(s => {
      if (s.venueId) return;
      const match = venues.find(v => v.name.toLowerCase() === s.name.toLowerCase());
      if (match) {
        DB.updateSchool({ ...s, venueId: match.id }).catch(console.warn);
        count++;
      }
    });
    if (count > 0) {
      toast(`🔗 ${count} school${count > 1 ? 's' : ''} linked to matching home venue${count > 1 ? 's' : ''}`, 'success');
      render();
    }
  }

  async function renderSchools() {
    _autoLinkSchoolVenues();
    const el = document.getElementById('schoolsList');
    const schools = DB.getSchools(); // already sorted alphabetically by getter
    if (schools.length === 0) {
      el.innerHTML = `<p class="text-muted">No schools yet.</p>`;
      return;
    }

    // Ensure users are loaded (may not be if Schools tab opened before Users tab)
    if (DB.getUsers().length === 0) await DB.loadUsers();

    // Build a quick-lookup set of registered phone suffixes + emails
    const regUsers = DB.getUsers();
    const _digits9 = p => (p || '').replace(/\D/g, '').slice(-9);
    const regPhones = new Set(regUsers.map(u => _digits9(u.phone)).filter(Boolean));
    const regEmails = new Set(regUsers.map(u => (u.email || '').toLowerCase()).filter(Boolean));
    const _isRegistered = o =>
      (o.phone && regPhones.has(_digits9(o.phone))) ||
      (o.email && regEmails.has(o.email.toLowerCase()));

    el.innerHTML = `<div class="admin-list">` +
      schools.map(s => {
        const venue   = DB.getVenues().find(v => v.id === s.venueId);
        const leagues = _schoolLeagues(s.id);

        // For each league, note which team(s) — single vs A/B
        const teamsBadges = leagues.length > 0
          ? leagues.map(l => {
              const myParts = (l.participants && l.participants.length > 0
                ? l.participants
                : (l.schoolIds || []).map(id => ({ participantId: id, schoolId: id, teamSuffix: '' }))
              ).filter(p => p.schoolId === s.id);
              const suffixes = myParts.map(p => p.teamSuffix).filter(Boolean);
              const label = esc(l.name)
                + (l.division ? ` · ${esc(l.division)}` : '')
                + (suffixes.length ? ` [${suffixes.join('+')}]` : '');
              return `<span class="badge badge-gray school-league-badge">${label}</span>`;
            }).join('')
          : `<span class="text-muted" style="font-size:.78rem">Not linked to any leagues</span>`;

        return `<div class="admin-list-item">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span class="color-dot" style="background:${s.color}"></span>
              <strong>${esc(s.name)}</strong>
              ${s.team ? `<span class="text-muted" style="font-size:.82rem">(${esc(s.team)})</span>` : ''}
            </div>
            <div class="text-muted">${venue ? esc(venue.name) : 'No home venue'}</div>
            ${(s.organizers && s.organizers.length
                ? s.organizers.map(o => `
                  <div class="text-muted" style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
                    <span>👤 ${esc(o.name)}${o.email ? ' · ' + esc(o.email) : ''}${o.phone ? ' · ' + esc(o.phone) : ''}</span>
                    ${_isRegistered(o)
                      ? `<span class="badge badge-green" style="font-size:.72rem">✅ Registered</span>`
                      : `${o.phone ? `<button class="btn btn-xs btn-success wa-invite-btn" data-phone="${esc(o.phone)}" data-name="${esc(o.name)}" data-school="${esc(s.name)}" title="Send WhatsApp invitation">📲 WhatsApp</button>` : ''}
                         ${o.email ? `<button class="btn btn-xs btn-info email-invite-btn" data-email="${esc(o.email)}" data-name="${esc(o.name)}" data-school="${esc(s.name)}" title="Send email invitation">✉️ Email</button>` : ''}`}
                  </div>`).join('')
                : s.contact ? `<div class="text-muted">👤 ${esc(s.contact)}${s.email ? ' · ' + esc(s.email) : ''}${s.phone ? ' · ' + esc(s.phone) : ''}</div>` : '')}
            <div class="school-teams" style="margin-top:.35rem">${teamsBadges}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-info"      data-school-view="${s.id}">👁 View</button>
            <button class="btn btn-xs btn-secondary" data-school-edit="${s.id}">Edit</button>
            <button class="btn btn-xs btn-secondary" data-school-notif="${s.id}">🔔</button>
            <button class="btn btn-xs btn-danger"    data-school-delete="${s.id}">Del</button>
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('[data-school-view]').forEach(btn => {
      btn.addEventListener('click', () => MySchool.impersonate(btn.dataset.schoolView));
    });
    el.querySelectorAll('[data-school-edit]').forEach(btn => {
      btn.addEventListener('click', () => openSchoolModal(btn.dataset.schoolEdit));
    });
    el.querySelectorAll('[data-school-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteSchool(btn.dataset.schoolDelete));
    });
    el.querySelectorAll('.wa-invite-btn').forEach(btn => {
      btn.addEventListener('click', () => _sendWhatsAppInvite(btn));
    });
    el.querySelectorAll('.email-invite-btn').forEach(btn => {
      btn.addEventListener('click', () => _sendEmailInvite(btn));
    });
    el.querySelectorAll('[data-school-notif]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = DB.getSchools().find(x => x.id === btn.dataset.schoolNotif);
        if (!s) return;
        NotificationService.openContextModal({
          title: `Notify — ${s.name}`,
          types: [
            {
              value:          'fixture_changed',
              label:          '📋 Fixture changes — notify school about fixture updates',
              subject:        `Fixture update for ${s.name}`,
              body:           `There have been updates to your upcoming fixtures. Please check your schedule.`,
              recipientLabel: `📬 Recipients: All users linked to ${s.name}`,
              sendFn: async (title, body) => {
                await NotificationService.sendToSchool(s.id, { type: 'fixture_changed', title, body });
              },
            },
            {
              value:          'general_message',
              label:          '📢 General message — send custom message to school',
              subject:        `Message to ${s.name}`,
              body:           '',
              recipientLabel: `📬 Recipients: All users linked to ${s.name}`,
              sendFn: async (title, body) => {
                await NotificationService.sendToSchool(s.id, { type: 'general_message', title, body });
              },
            },
            {
              value:          'score_reminder',
              label:          '⏰ Score reminder — remind school to submit scores',
              subject:        `Please submit your scores — ${s.name}`,
              body:           `This is a reminder to submit outstanding match scores. Please update your results as soon as possible.`,
              recipientLabel: `📬 Recipients: All users linked to ${s.name}`,
              sendFn: async (title, body) => {
                await NotificationService.sendToSchool(s.id, { type: 'score_reminder', title, body });
              },
            },
          ],
        });
      });
    });
    _applySearch('schoolsSearch', '#schoolsList', '.admin-list-item');
  }

  function openSchoolModal(id) {
    const s = id ? DB.getSchools().find(x => x.id === id) : null;
    const venues = DB.getVenues();
    document.getElementById('schoolModalTitle').textContent = s ? 'Edit School' : 'Add School';
    document.getElementById('schoolName').value             = s ? s.name : '';
    document.getElementById('schoolTeam').value             = s ? (s.team    || '') : '';
    document.getElementById('schoolContact').value          = s ? (s.contact || '') : '';
    document.getElementById('schoolEmail').value            = s ? (s.email   || '') : '';
    document.getElementById('schoolPhone').value            = s ? (s.phone   || '') : '';
    document.getElementById('schoolColor').value            = s ? (s.color   || '#3b82f6') : '#3b82f6';
    document.getElementById('schoolEditId').value           = s ? s.id : '';
    const vSel = document.getElementById('schoolVenue');
    vSel.innerHTML = `<option value="">No home venue</option>` +
      venues.map(v => `<option value="${v.id}"${s && s.venueId === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
    // Populate organizers
    const orgsEl = document.getElementById('schoolOrganizers');
    const seed = (s && s.organizers && s.organizers.length)
      ? s.organizers
      : (s && s.contact ? [{ name: s.contact, email: s.email || '', phone: s.phone || '' }] : []);
    orgsEl.innerHTML = seed.map(_orgRow).join('');
    document.getElementById('addOrganizerBtn').onclick = () => {
      orgsEl.insertAdjacentHTML('beforeend', _orgRow({ name: '', email: '', phone: '' }));
      _wireOrgRemoveButtons();
    };
    _wireOrgRemoveButtons();
    Modal.open('schoolModal');
  }

  async function saveSchool() {
    const name  = document.getElementById('schoolName').value.trim();
    const phone = document.getElementById('schoolPhone').value.trim();
    if (!name) { toast('School name required', 'error'); return; }
    if (!_validPhone(phone)) {
      toast('Each phone number must be 10 digits starting with 0 (separate multiple numbers with /)', 'error'); return;
    }
    const id = document.getElementById('schoolEditId').value;
    const organizers = [...document.querySelectorAll('#schoolOrganizers .organizer-row')].map(row => ({
      name:  row.querySelector('.org-name').value.trim(),
      email: row.querySelector('.org-email').value.trim(),
      phone: row.querySelector('.org-phone').value.trim(),
    })).filter(o => o.name || o.email);
    const school = {
      id:      id || uid(),
      name,
      team:    document.getElementById('schoolTeam').value.trim(),
      venueId: document.getElementById('schoolVenue').value || null,
      contact: document.getElementById('schoolContact').value.trim(),
      email:   document.getElementById('schoolEmail').value.trim(),
      phone,
      color:   document.getElementById('schoolColor').value,
      organizers,
    };
    Modal.close('schoolModal');
    if (id) {
      const savePromise = DB.updateSchool(school);
      DB.writeAudit('school_updated', 'admin', `School updated: ${name}`, id, name);
      render(); Leagues.refresh();
      try {
        await savePromise;
        toast('School updated', 'success');
      } catch (e) {
        console.error('School update failed:', e);
        toast('Save failed — ' + (e.message || 'permission denied'), 'error');
        render(); Leagues.refresh();
      }
    } else {
      render(); Leagues.refresh();
      try {
        await DB.addSchool(school);
        DB.writeAudit('school_added', 'admin', `School added: ${name}`, school.id, name);
        toast('School added', 'success');
        render(); Leagues.refresh();
      } catch (e) {
        console.error('School add failed:', e);
        toast('Save failed — ' + (e.message || 'permission denied'), 'error');
        render(); Leagues.refresh();
      }
    }
  }

  /** Send a WhatsApp invitation to a school organizer via the Cloud Function. */
  async function _sendWhatsAppInvite(btn) {
    const phone      = btn.dataset.phone;
    const name       = btn.dataset.name;
    const schoolName = btn.dataset.school;
    if (!phone) { toast('No phone number on record for this organizer', 'error'); return; }

    btn.disabled    = true;
    btn.textContent = 'Sending…';

    try {
      const fn = firebase.functions().httpsCallable('sendWhatsAppInvite');
      await fn({ phone, contactName: name, schoolName });
      toast(`WhatsApp invite sent to ${name || phone} ✓`, 'success');
      btn.textContent = '✓ Sent';
    } catch (err) {
      console.error('[WhatsApp] Invite failed:', err);
      toast('Could not send invite — ' + (err.message || 'check Twilio credentials'), 'error');
      btn.disabled    = false;
      btn.textContent = '📲 Invite';
    }
  }

  /** Send an email invitation to a school organizer via the Cloud Function. */
  async function _sendEmailInvite(btn) {
    const email      = btn.dataset.email;
    const name       = btn.dataset.name;
    const schoolName = btn.dataset.school;
    if (!email) { toast('No email address on record for this organizer', 'error'); return; }

    btn.disabled    = true;
    btn.textContent = 'Sending…';

    try {
      const fn = firebase.functions().httpsCallable('sendEmailInvite');
      await fn({ email, contactName: name, schoolName });
      toast(`Email invite sent to ${name || email} ✓`, 'success');
      btn.textContent = '✓ Sent';
    } catch (err) {
      console.error('[Email] Invite failed:', err);
      toast('Could not send email — ' + (err.message || 'check email credentials'), 'error');
      btn.disabled    = false;
      btn.textContent = '✉️ Email';
    }
  }

  async function deleteSchool(id) {
    const school = DB.getSchools().find(s => s.id === id);
    if (!confirm('Delete this school?')) return;
    DB.writeAudit('school_deleted', 'admin', `School deleted: ${school ? school.name : id}`, id, school ? school.name : id);
    const deletePromise = DB.deleteSchool(id);
    render(); Leagues.refresh();
    try {
      await deletePromise;
      toast('School deleted', 'success');
    } catch (e) {
      console.error('School delete failed:', e);
      toast('Delete failed — ' + (e.message || 'permission denied'), 'error');
      render(); Leagues.refresh();
    }
  }

  // ════════════════════════════════════════════════════════════
  // CLOSURES
  // ════════════════════════════════════════════════════════════
  function renderClosures() {
    const el = document.getElementById('closuresList');
    const closures = DB.getClosures();
    if (closures.length === 0) {
      el.innerHTML = `<p class="text-muted">No closures defined.</p>`;
      return;
    }
    el.innerHTML = `<div class="admin-list">` +
      closures.map(c => {
        const venue      = DB.getVenues().find(v => v.id === c.venueId);
        const courtLabel = c.courtIndex !== null && c.courtIndex !== undefined && c.courtIndex !== ''
          ? ` · Court ${parseInt(c.courtIndex) + 1}` : '';
        const timeLabel  = c.timeStart && c.timeEnd ? ` · ${c.timeStart}–${c.timeEnd}` : '';
        const isOpen     = c.type === 'open';
        const typeBadge  = isOpen
          ? `<span class="badge" style="background:#d1fae5;color:#065f46;font-size:.7rem;margin-left:.4rem">Open window</span>`
          : `<span class="badge" style="background:#fee2e2;color:#991b1b;font-size:.7rem;margin-left:.4rem">Blocked</span>`;
        return `<div class="admin-list-item">
          <div>
            <span><strong>${venue ? esc(venue.name) : 'Unknown'}${courtLabel}</strong>${typeBadge}</span>
            <div class="text-muted">${formatDate(c.startDate)} → ${formatDate(c.endDate)}${timeLabel}</div>
            ${c.reason ? `<div class="text-muted">${esc(c.reason)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-danger" data-closure-delete="${c.id}">Del</button>
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('[data-closure-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cid = btn.dataset.closureDelete;
        DB.writeAudit('closure_deleted', 'admin', `Court closure removed`, cid);
        const deletePromise = DB.deleteClosure(cid);
        render(); Calendar.refresh();
        try {
          await deletePromise;
          toast('Closure removed', 'success');
        } catch (e) {
          console.error('Closure delete failed:', e);
          toast('Delete failed — ' + (e.message || 'permission denied'), 'error');
          render(); Calendar.refresh();
        }
      });
    });
  }

  function openClosureModal() {
    const venues = DB.getVenues();
    const vSel   = document.getElementById('closureVenue');
    vSel.innerHTML = venues.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
    updateClosureCourtList();
    document.getElementById('closureStart').value     = toDateStr(new Date());
    document.getElementById('closureEnd').value       = toDateStr(new Date());
    document.getElementById('closureTimeStart').value = '';
    document.getElementById('closureTimeEnd').value   = '';
    document.getElementById('closureReason').value    = '';
    _updateClosureModalTitle();
    Modal.open('closureModal');
  }

  function _updateClosureModalTitle() {
    const venueId = document.getElementById('closureVenue').value;
    const venue   = DB.getVenues().find(v => v.id === venueId);
    const titleEl = document.querySelector('#closureModal .modal-header h3');
    if (titleEl) titleEl.textContent = (venue && venue.restrictedMode) ? 'Add Open Window' : 'Add Court Closure';
  }

  function updateClosureCourtList() {
    const venueId = document.getElementById('closureVenue').value;
    const venue   = DB.getVenues().find(v => v.id === venueId);
    const sel     = document.getElementById('closureCourt');
    sel.innerHTML = `<option value="">Entire Venue</option>`;
    if (venue) {
      for (let i = 0; i < (venue.courts || 0); i++) {
        sel.innerHTML += `<option value="${i}">Court ${i + 1}</option>`;
      }
    }
  }

  function saveClosure() {
    const venueId   = document.getElementById('closureVenue').value;
    if (!venueId) { toast('Select a venue', 'error'); return; }
    const startDate = document.getElementById('closureStart').value;
    const endDate   = document.getElementById('closureEnd').value;
    if (!startDate || !endDate) { toast('Dates required', 'error'); return; }
    const courtVal  = document.getElementById('closureCourt').value;
    const venue     = DB.getVenues().find(v => v.id === venueId);
    const reason    = document.getElementById('closureReason').value.trim();

    const isRestricted = !!(venue && venue.restrictedMode);
    DB.addClosure({
      venueId,
      courtIndex: courtVal !== '' ? parseInt(courtVal) : null,
      startDate, endDate,
      timeStart: document.getElementById('closureTimeStart').value || null,
      timeEnd:   document.getElementById('closureTimeEnd').value   || null,
      reason,
      type: isRestricted ? 'open' : 'block',
    });
    DB.writeAudit(
      'closure_added', 'admin',
      `Closure: ${venue ? venue.name : venueId}${courtVal !== '' ? ` Court ${parseInt(courtVal)+1}` : ''} ${startDate}–${endDate}${reason ? ` (${reason})` : ''}`,
      venueId, venue ? venue.name : venueId
    );
    Modal.close('closureModal');
    render();
    Calendar.refresh();
    toast('Closure added', 'success');
  }

  // ════════════════════════════════════════════════════════════
  // PASSWORD (via Firebase Auth)
  // ════════════════════════════════════════════════════════════
  async function changePassword() {
    const np  = document.getElementById('newPassword').value;
    if (!np || np.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
    const btn = document.getElementById('changePasswordBtn');
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      await Auth.changePassword(np);
      document.getElementById('newPassword').value = '';
      DB.writeAudit('password_changed', 'admin', 'Master password changed');
      toast('Password updated ✓', 'success');
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') {
        toast('Please log out and sign in again before changing your password', 'error');
      } else {
        toast('Error: ' + err.message, 'error');
      }
    } finally {
      btn.disabled = false; btn.textContent = 'Update';
    }
  }

  return { init, refresh };
})();
