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

    const venue     = school.venueId ? DB.getVenues().find(v => v.id === school.venueId) : null;
    const myLeagues = DB.getLeagues().filter(l => _parts(l).some(p => p.schoolId === schoolId));

    // Show school header
    let html = `<div class="myschool-header">
      <span class="color-dot" style="background:${school.color};width:20px;height:20px;flex-shrink:0"></span>
      <div>
        <div class="myschool-school-name">${esc(school.name)}</div>
        ${school.team  ? `<div class="text-muted">${esc(school.team)}</div>` : ''}
        ${venue        ? `<div class="text-muted">🏟 ${esc(venue.name)}</div>` : ''}
        ${school.contact ? `<div class="text-muted">👤 ${esc(school.contact)}${school.email ? ' · ' + esc(school.email) : ''}${school.phone ? ' · ' + esc(school.phone) : ''}</div>` : ''}
      </div>
    </div>`;

    if (myLeagues.length === 0) {
      html += `<div class="empty-state">
        <div class="empty-icon">🏆</div>
        <p>${_impersonateSchoolId ? 'This school is not enrolled in any leagues yet.' : 'Your school is not enrolled in any leagues yet.'}</p>
      </div>`;
    } else {
      html += myLeagues.map(l => _leagueSection(l, schoolId)).join('');
    }

    container.innerHTML = html;

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
        const newDate = prompt('Enter requested new date (YYYY-MM-DD):');
        if (!newDate) return;
        const newTime = prompt('Enter requested new time (HH:MM) or leave blank to keep current:') || '';
        const note    = prompt('Optional note for admin:') || '';
        _submitChangeRequest(btn.dataset.lid, btn.dataset.fid, 'reschedule',
          { requestedDate: newDate, requestedTime: newTime, note });
      });
    });

    // Request alternate venue
    container.querySelectorAll('.ms-altvenue-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const venues    = DB.getVenues();
        const venueList = venues.map((v, i) => `${i + 1}. ${v.name}`).join('\n');
        const pick      = prompt(`Select alternate venue:\n${venueList}\n\nEnter number:`);
        if (!pick) return;
        const idx = parseInt(pick) - 1;
        if (isNaN(idx) || !venues[idx]) { toast('Invalid selection', 'error'); return; }
        const note = prompt('Optional note for admin:') || '';
        _submitChangeRequest(btn.dataset.lid, btn.dataset.fid, 'venue',
          { requestedVenueId: venues[idx].id, note });
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

    const upcoming = myFixtures
      .filter(f => f.homeScore === null || f.homeScore === undefined)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const recent = myFixtures
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

    const DAYS     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayLabel = league.playingDay !== undefined ? ` · ${DAYS[league.playingDay]}s` : '';

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
        let requestBtns = '';
        if (!hasRequest && Auth.isLoggedIn()) {
          requestBtns = `<button class="btn btn-xs btn-secondary ms-reschedule-btn"
            data-lid="${leagueId}" data-fid="${f.id}">📅 Request Reschedule</button>
            <button class="btn btn-xs btn-secondary ms-altvenue-btn"
            data-lid="${leagueId}" data-fid="${f.id}">🏟 Alt. Venue</button>`;
        }
        clashHtml = `<div class="fixture-clash-badge">⚠️ Venue clash on this day ${requestBtns}</div>`;
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
    </div>`;
  }

  return { init, refresh, impersonate, stopImpersonation, isImpersonating };
})();
