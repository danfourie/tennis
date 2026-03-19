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
    // Return to admin if the user is an admin, else calendar
    if (Auth.isAdmin()) {
      document.querySelector('[data-view="admin"]')?.click();
    } else {
      document.querySelector('[data-view="calendar"]')?.click();
    }
  }

  function isImpersonating() { return _impersonateSchoolId !== null; }

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
    let html = `<div class="myschool-header">
      <span class="color-dot" style="background:${school.color};width:20px;height:20px;flex-shrink:0"></span>
      <div>
        <div class="myschool-school-name">${esc(school.name)}</div>
        ${school.team  ? `<div class="text-muted">${esc(school.team)}</div>` : ''}
        ${venue        ? `<div class="text-muted">🏟 ${esc(venue.name)}</div>` : ''}
        ${(school.organizers && school.organizers.length
            ? school.organizers.map(o => `<div class="text-muted">👤 ${esc(o.name)}${o.email ? ' · ' + esc(o.email) : ''}${o.phone ? ' · ' + esc(o.phone) : ''}</div>`).join('')
            : school.contact ? `<div class="text-muted">👤 ${esc(school.contact)}${school.email ? ' · ' + esc(school.email) : ''}${school.phone ? ' · ' + esc(school.phone) : ''}</div>` : '')}
      </div>
    </div>`;

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

    // Score-entry listeners
    container.querySelectorAll('.my-score-input').forEach(inp => {
      inp.addEventListener('change', () => {
        Leagues.saveScore(inp.dataset.league, inp.dataset.fixture, inp.dataset.field, inp.value);
        _render();
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
        const lid      = btn.dataset.lid;
        const fid      = btn.dataset.fid;
        const oppId    = btn.dataset.oppId;
        const oppName  = btn.dataset.oppName;
        const date     = btn.dataset.date;
        const venue    = btn.dataset.venue;
        const dateStr  = date ? formatDate(date) : 'TBA';
        NotificationService.openContextModal({
          title: '🏟 Alternative Venue Request',
          types: [{
            value: 'alt_venue',
            label: 'Alternative Venue Update',
            subject: `Alternative venue request – fixture on ${dateStr}`,
            body: `We would like to use an alternative venue for the fixture originally scheduled at ${venue || 'TBA'} on ${dateStr}. Please advise on availability.`,
            recipientLabel: `Sends to: ${oppName || 'opposition'} users + all admin users`,
            sendFn: async (title, body) => {
              if (oppId) await NotificationService.sendToSchool(oppId, { type: 'fixture_changed', title, body, leagueId: lid, fixtureId: fid });
              await NotificationService.sendToMasters({ type: 'fixture_changed', title, body, leagueId: lid, fixtureId: fid });
              _submitChangeRequest(lid, fid, 'venue', { note: body });
            },
          }],
        });
      });
    });
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

    const allUpcoming = myFixtures
      .filter(f => f.homeScore === null || f.homeScore === undefined)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const upcoming = _fixtureView === 'next' ? allUpcoming.slice(0, 1) : allUpcoming;

    const recent = _fixtureView === 'next' ? [] : myFixtures
      .filter(f => f.homeScore !== null && f.homeScore !== undefined)
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
      html += recent.map(f => _fixtureRow(f, league.id, myParticipantIds, false, clashedIds)).join('');
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
    let scoreHtml;
    if (canEdit && Auth.isLoggedIn()) {
      scoreHtml = `
        <input class="my-score-input score-input" type="number" min="0" max="99"
          value="${hasScore ? f.homeScore : ''}"
          data-league="${leagueId}" data-fixture="${f.id}" data-field="homeScore"
          style="width:54px;text-align:center">
        <span style="color:var(--neutral);margin:0 .2rem">—</span>
        <input class="my-score-input score-input" type="number" min="0" max="99"
          value="${hasScore ? f.awayScore : ''}"
          data-league="${leagueId}" data-fixture="${f.id}" data-field="awayScore"
          style="width:54px;text-align:center">`;
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
            data-date="${esc(f.date || '')}" data-venue="${esc(f.venueName || '')}">🏟 Alt. Venue</button>`;
        }
        clashHtml = `<div class="fixture-clash-badge">⚠️ Potential venue clash on this day ${requestBtns}</div>`;
        if (hasRequest) {
          const cr    = f.changeRequest;
          const vName = cr.requestedVenueId
            ? ((DB.getVenues().find(v => v.id === cr.requestedVenueId) || {}).name || cr.requestedVenueId)
            : null;
          const detail = cr.type === 'venue'
            ? `Alt. venue: ${vName}`
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
      ${notifBtnHtml}
    </div>`;
  }

  return { init, refresh, impersonate, stopImpersonation, isImpersonating };
})();
