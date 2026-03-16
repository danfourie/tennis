/**
 * myschool.js — Personalised "My School" view for school-linked users.
 *
 * Shows:
 *   - School name + home venue
 *   - Each league the school is enrolled in:
 *       ▸ Standing (position + P/W/D/L/Pts)
 *       ▸ Upcoming fixtures with score-entry inputs
 *       ▸ Recent results (W/D/L badge)
 *
 * Score submission calls Leagues.saveScore() so standings stay in sync
 * with the main Leagues view.
 */

const MySchool = (() => {

  // ── helpers ─────────────────────────────────────────────────
  /** Backward-compatible participant list for a league. */
  function _parts(league) {
    return league.participants && league.participants.length > 0
      ? league.participants
      : (league.schoolIds || []).map(id => ({ participantId: id, schoolId: id, teamSuffix: '' }));
  }

  /** Show / hide the My School nav button based on login + schoolId. */
  function _syncNav() {
    const btn = document.querySelector('[data-view="myschool"]');
    if (!btn) return;
    const profile   = Auth.getProfile();
    const hasSchool = Auth.isLoggedIn() && profile && profile.schoolId;
    btn.classList.toggle('hidden', !hasSchool);
    // If the nav is now hidden but the view is active, fall back to calendar
    if (!hasSchool) {
      const view = document.getElementById('view-myschool');
      if (view && !view.classList.contains('hidden')) {
        // trigger a switch to calendar via app navigation
        document.querySelector('[data-view="calendar"]')?.click();
      }
    }
  }

  // ── public API ──────────────────────────────────────────────
  function init() {
    // Nothing to wire at init time; auth calls refresh() after login.
  }

  function refresh() {
    _syncNav();
    const view = document.getElementById('view-myschool');
    if (view && !view.classList.contains('hidden')) _render();
  }

  // ── main render ─────────────────────────────────────────────
  function _render() {
    const container = document.getElementById('myschoolContent');
    if (!container) return;

    const profile = Auth.getProfile();
    if (!profile || !profile.schoolId) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏫</div>
        <p>No school is linked to your account yet.<br>
           Contact an admin to link your account to your school.</p>
      </div>`;
      return;
    }

    const schoolId = profile.schoolId;
    const school   = DB.getSchools().find(s => s.id === schoolId);
    if (!school) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏫</div>
        <p>Your linked school could not be found. Contact an admin.</p>
      </div>`;
      return;
    }

    // Update page title
    const title = document.getElementById('myschoolTitle');
    if (title) title.textContent = school.name;

    const venue     = school.venueId ? DB.getVenues().find(v => v.id === school.venueId) : null;
    const myLeagues = DB.getLeagues().filter(l => _parts(l).some(p => p.schoolId === schoolId));

    let html = `<div class="myschool-header">
      <span class="color-dot" style="background:${school.color};width:20px;height:20px;flex-shrink:0"></span>
      <div>
        <div class="myschool-school-name">${esc(school.name)}</div>
        ${school.team  ? `<div class="text-muted">${esc(school.team)}</div>` : ''}
        ${venue        ? `<div class="text-muted">🏟 ${esc(venue.name)}</div>` : ''}
      </div>
    </div>`;

    if (myLeagues.length === 0) {
      html += `<div class="empty-state">
        <div class="empty-icon">🏆</div>
        <p>Your school is not enrolled in any leagues yet.</p>
      </div>`;
    } else {
      html += myLeagues.map(l => _leagueSection(l, schoolId)).join('');
    }

    container.innerHTML = html;

    // Attach score listeners
    container.querySelectorAll('.my-score-input').forEach(inp => {
      inp.addEventListener('change', () => {
        Leagues.saveScore(inp.dataset.league, inp.dataset.fixture, inp.dataset.field, inp.value);
        // Re-render so standing & result badge update
        _render();
      });
    });
  }

  // ── per-league section ──────────────────────────────────────
  function _leagueSection(league, schoolId) {
    const myParts          = _parts(league).filter(p => p.schoolId === schoolId);
    const myParticipantIds = myParts.map(p => p.participantId);

    const myFixtures = (league.fixtures || []).filter(f => {
      const hk = f.homeParticipantId || f.homeSchoolId;
      const ak = f.awayParticipantId || f.awaySchoolId;
      return myParticipantIds.includes(hk) || myParticipantIds.includes(ak);
    });

    const upcoming = myFixtures
      .filter(f => f.homeScore === null || f.homeScore === undefined)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const recent = myFixtures
      .filter(f => f.homeScore !== null && f.homeScore !== undefined)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 5);

    const myStandings   = (league.standings || []).filter(r => myParticipantIds.includes(r.participantId));
    const totalTeams    = (league.standings || []).length;

    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayLabel = league.playingDay !== undefined ? ` · ${DAYS[league.playingDay]}s` : '';

    let html = `<div class="myschool-league card">
      <div class="card-header">
        <div>
          <div class="card-title">🏆 ${esc(league.name)}</div>
          <div class="text-muted">${esc(league.division || '')}${dayLabel}${league.matchTime ? ' · ' + league.matchTime : ''}</div>
        </div>
      </div>
      <div class="card-body">`;

    // Standings summary
    if (myStandings.length > 0) {
      html += `<div class="myschool-standings">`;
      myStandings.forEach(row => {
        const pos       = (league.standings || []).findIndex(r => r.participantId === row.participantId) + 1;
        const posClass  = pos === 1 ? 'badge-green' : pos === 2 ? 'badge-amber' : 'badge-gray';
        html += `<div class="myschool-standing-row">
          <span class="badge ${posClass}">#${pos} / ${totalTeams}</span>
          <strong>${esc(row.name)}</strong>
          <span class="text-muted">${row.played}P · ${row.won}W · ${row.drawn}D · ${row.lost}L</span>
          <span class="myschool-pts">${row.points} pts</span>
        </div>`;
      });
      html += `</div>`;
    }

    // Upcoming fixtures
    if (upcoming.length > 0) {
      html += `<div class="myschool-section-label">📅 Upcoming Fixtures</div>`;
      html += upcoming.map(f => _fixtureRow(f, league.id, myParticipantIds, true)).join('');
    }

    // Recent results
    if (recent.length > 0) {
      html += `<div class="myschool-section-label">📊 Recent Results</div>`;
      html += recent.map(f => _fixtureRow(f, league.id, myParticipantIds, false)).join('');
    }

    if (upcoming.length === 0 && recent.length === 0) {
      html += `<p class="text-muted" style="margin:.5rem 0">No fixtures scheduled yet.</p>`;
    }

    html += `</div></div>`;
    return html;
  }

  // ── fixture row ─────────────────────────────────────────────
  function _fixtureRow(f, leagueId, myParticipantIds, canEdit) {
    const hasScore = f.homeScore !== null && f.homeScore !== undefined;
    const homeKey  = f.homeParticipantId || f.homeSchoolId;
    const isHome   = myParticipantIds.includes(homeKey);

    const schools    = DB.getSchools();
    const homeSchool = schools.find(s => s.id === f.homeSchoolId);
    const awaySchool = schools.find(s => s.id === f.awaySchoolId);
    const hColor     = homeSchool ? homeSchool.color : '#666';
    const aColor     = awaySchool ? awaySchool.color : '#666';

    let scoreHtml;
    if (canEdit && Auth.isLoggedIn()) {
      scoreHtml = `
        <input class="my-score-input score-input" type="number" min="0" max="99"
          value="${hasScore ? f.homeScore : ''}"
          data-league="${leagueId}" data-fixture="${f.id}" data-field="homeScore"
          style="width:38px;text-align:center">
        <span style="color:var(--neutral);margin:0 .2rem">—</span>
        <input class="my-score-input score-input" type="number" min="0" max="99"
          value="${hasScore ? f.awayScore : ''}"
          data-league="${leagueId}" data-fixture="${f.id}" data-field="awayScore"
          style="width:38px;text-align:center">`;
    } else if (hasScore) {
      const outcome   = isHome
        ? (f.homeScore > f.awayScore ? 'W' : f.homeScore < f.awayScore ? 'L' : 'D')
        : (f.awayScore > f.homeScore ? 'W' : f.awayScore < f.homeScore ? 'L' : 'D');
      const outcClass = outcome === 'W' ? 'badge-green' : outcome === 'L' ? 'badge-red' : 'badge-gray';
      scoreHtml = `<span class="badge ${outcClass}" style="margin-right:.25rem">${outcome}</span><strong>${f.homeScore} — ${f.awayScore}</strong>`;
    } else {
      scoreHtml = `<span class="text-muted">vs</span>`;
    }

    return `<div class="myschool-fixture ${isHome ? 'home-fixture' : 'away-fixture'}">
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
    </div>`;
  }

  return { init, refresh };
})();
