/**
 * leagues.js — School league management and fixture generation
 */

const Leagues = (() => {

  function init() {
    document.getElementById('addLeagueBtn').addEventListener('click', () => openLeagueModal());
    document.getElementById('leagueSubmitBtn').addEventListener('click', saveLeague);
    render();
  }

  function refresh() { render(); }

  function render() {
    const container = document.getElementById('leaguesList');
    const leagues = DB.getLeagues();
    if (leagues.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><p>No leagues yet. Add one to get started.</p></div>`;
      return;
    }
    container.innerHTML = leagues.map(l => _leagueCard(l)).join('');
    container.querySelectorAll('[data-league-view]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueDetail(btn.dataset.leagueView));
    });
    container.querySelectorAll('[data-league-edit]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueModal(btn.dataset.leagueEdit));
    });
    container.querySelectorAll('[data-league-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteLeague(btn.dataset.leagueDelete));
    });
  }

  function _leagueCard(l) {
    const schools = (l.schoolIds || []).map(id => DB.getSchools().find(s => s.id === id)).filter(Boolean);
    const totalFixtures = l.fixtures ? l.fixtures.length : 0;
    const played = l.fixtures ? l.fixtures.filter(f => f.homeScore !== null && f.homeScore !== undefined).length : 0;
    const statusBadge = played === totalFixtures && totalFixtures > 0
      ? `<span class="badge badge-green">Complete</span>`
      : played > 0
        ? `<span class="badge badge-amber">In Progress</span>`
        : `<span class="badge badge-gray">Pending</span>`;

    return `<div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(l.name)}</div>
          <div class="text-muted">${esc(l.division || '')}</div>
        </div>
        ${statusBadge}
      </div>
      <div class="card-body">
        <div class="flex gap-1 items-center" style="flex-wrap:wrap;gap:.4rem;margin-bottom:.5rem">
          ${schools.map(s => `<span class="badge" style="background:${s.color}22;color:${s.color};border:1px solid ${s.color}44">${esc(s.name)}</span>`).join('')}
        </div>
        <div class="text-muted">${l.startDate ? formatDate(l.startDate) : '—'} → ${l.endDate ? formatDate(l.endDate) : '—'}</div>
        <div class="text-muted mt-1">${totalFixtures} fixtures · ${played} played</div>
      </div>
      <div class="card-footer">
        <button class="btn btn-sm btn-secondary" data-league-view="${l.id}">View Fixtures</button>
        ${Auth.isAdmin() ? `<button class="btn btn-sm btn-secondary" data-league-edit="${l.id}">Edit</button>
        <button class="btn btn-sm btn-danger" data-league-delete="${l.id}">Delete</button>` : ''}
      </div>
    </div>`;
  }

  function openLeagueModal(id) {
    const schools = DB.getSchools();
    const venues = DB.getVenues();
    const l = id ? DB.getLeagues().find(x => x.id === id) : null;

    document.getElementById('leagueModalTitle').textContent = l ? 'Edit League' : 'Add League';
    document.getElementById('leagueName').value = l ? l.name : '';
    document.getElementById('leagueDivision').value = l ? (l.division || '') : '';
    document.getElementById('leagueStart').value = l ? (l.startDate || '') : '';
    document.getElementById('leagueEnd').value = l ? (l.endDate || '') : '';
    document.getElementById('leagueHomeMatches').value = l ? (l.homeMatches || 1) : 1;
    document.getElementById('leagueEditId').value = l ? l.id : '';

    // Neutral venue select
    const neutralSel = document.getElementById('leagueNeutralVenue');
    neutralSel.innerHTML = `<option value="">None</option>` +
      venues.map(v => `<option value="${v.id}"${l && l.neutralVenueId === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('');

    // School checkboxes
    const box = document.getElementById('leagueSchoolsCheckboxes');
    box.innerHTML = schools.map(s =>
      `<label><input type="checkbox" value="${s.id}" ${l && l.schoolIds && l.schoolIds.includes(s.id) ? 'checked' : ''}>
        <span style="color:${s.color}">●</span> ${esc(s.name)}</label>`
    ).join('');

    Modal.open('leagueModal');
  }

  function saveLeague() {
    const name = document.getElementById('leagueName').value.trim();
    if (!name) { toast('League name required', 'error'); return; }

    const schoolIds = [...document.querySelectorAll('#leagueSchoolsCheckboxes input:checked')].map(i => i.value);
    if (schoolIds.length < 2) { toast('At least 2 schools required', 'error'); return; }

    const id = document.getElementById('leagueEditId').value;
    const homeMatches = parseInt(document.getElementById('leagueHomeMatches').value) || 1;
    const startDate = document.getElementById('leagueStart').value;
    const endDate = document.getElementById('leagueEnd').value;
    const neutralVenueId = document.getElementById('leagueNeutralVenue').value || null;

    const league = {
      id: id || uid(),
      name,
      division: document.getElementById('leagueDivision').value.trim(),
      startDate, endDate,
      schoolIds,
      homeMatches,
      neutralVenueId,
      fixtures: generateFixtures(schoolIds, homeMatches, startDate, neutralVenueId),
      standings: generateStandings(schoolIds),
    };

    if (id) {
      DB.updateLeague(league);
      DB.writeAudit('league_updated', 'league', `Updated league: ${name}`, league.id, name);
      toast('League updated', 'success');
    } else {
      DB.addLeague(league);
      DB.writeAudit('league_created', 'league', `Created league: ${name}`, league.id, name);
      toast('League created', 'success');
    }

    Modal.close('leagueModal');
    render();
    Calendar.refresh();
  }

  /**
   * Generate round-robin fixtures ensuring equal home/away games.
   * Uses the circle method (Berger tables).
   */
  function generateFixtures(schoolIds, homeMatchesPerPair, startDateStr, neutralVenueId) {
    const n = schoolIds.length;
    const fixtures = [];
    const schools = schoolIds.map(id => DB.getSchools().find(s => s.id === id)).filter(Boolean);

    // Round-robin pairs (each pair plays home+away)
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let round = 0; round < homeMatchesPerPair; round++) {
          pairs.push({ home: schools[i], away: schools[j], round });
          pairs.push({ home: schools[j], away: schools[i], round });
        }
      }
    }

    // Assign venues and dates
    let currentDate = startDateStr ? parseDate(startDateStr) : new Date();
    // Skip to next weekday if needed
    while ([0, 6].includes(currentDate.getDay())) currentDate = addDays(currentDate, 1);

    pairs.forEach((pair, idx) => {
      // Venue: home school's venue, or neutral if home has no courts
      const homeSchool = pair.home;
      const homeVenue = homeSchool.venueId
        ? DB.getVenues().find(v => v.id === homeSchool.venueId)
        : null;
      const hasHome = homeVenue && (homeVenue.courts || 0) > 0;
      const venueId = hasHome ? homeVenue.id : (neutralVenueId || null);
      const venueName = venueId
        ? (DB.getVenues().find(v => v.id === venueId) || {}).name || 'Neutral'
        : 'TBA';

      // Date: spread ~1 per week
      const matchDate = addDays(currentDate, idx * 7);
      let d = new Date(matchDate);
      while ([0, 6].includes(d.getDay())) d = addDays(d, 1);

      fixtures.push({
        id: uid(),
        homeSchoolId: pair.home.id,
        homeSchoolName: pair.home.name,
        awaySchoolId: pair.away.id,
        awaySchoolName: pair.away.name,
        venueId,
        venueName,
        isNeutral: !hasHome,
        date: toDateStr(d),
        timeSlot: '14:00',
        courtIndex: 0,
        homeScore: null,
        awayScore: null,
        round: pair.round + 1,
      });
    });

    return fixtures;
  }

  function generateStandings(schoolIds) {
    return schoolIds.map(id => {
      const s = DB.getSchools().find(x => x.id === id);
      return { schoolId: id, name: s ? s.name : id, played: 0, won: 0, lost: 0, drawn: 0, points: 0 };
    });
  }

  function recalcStandings(league) {
    const standings = {};
    league.schoolIds.forEach(id => {
      standings[id] = { schoolId: id, played: 0, won: 0, lost: 0, drawn: 0, points: 0 };
    });
    (league.fixtures || []).forEach(f => {
      if (f.homeScore === null || f.homeScore === undefined) return;
      const h = f.homeScore, a = f.awayScore;
      standings[f.homeSchoolId].played++;
      standings[f.awaySchoolId].played++;
      if (h > a) {
        standings[f.homeSchoolId].won++; standings[f.homeSchoolId].points += 3;
        standings[f.awaySchoolId].lost++;
      } else if (a > h) {
        standings[f.awaySchoolId].won++; standings[f.awaySchoolId].points += 3;
        standings[f.homeSchoolId].lost++;
      } else {
        standings[f.homeSchoolId].drawn++; standings[f.homeSchoolId].points++;
        standings[f.awaySchoolId].drawn++; standings[f.awaySchoolId].points++;
      }
    });
    league.standings = Object.values(standings).sort((a, b) => b.points - a.points || b.won - a.won);
    return league;
  }

  function openLeagueDetail(id) {
    const league = DB.getLeagues().find(l => l.id === id);
    if (!league) return;
    const schools = DB.getSchools();

    document.getElementById('leagueDetailTitle').textContent = league.name;
    const body = document.getElementById('leagueDetailBody');

    // Recalc standings
    recalcStandings(league);
    DB.updateLeague(league);

    // Tab structure
    body.innerHTML = `
      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="fixtures">Fixtures</button>
        <button class="modal-tab" data-tab="standings">Standings</button>
      </div>
      <div id="tab-fixtures">${_fixturesTab(league, schools)}</div>
      <div id="tab-standings" class="hidden">${_standingsTab(league, schools)}</div>
    `;

    body.querySelectorAll('.modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        body.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        body.querySelectorAll('[id^="tab-"]').forEach(p => p.classList.add('hidden'));
        document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
      });
    });

    // Score editing — any logged-in user can enter scores
    if (Auth.isLoggedIn()) {
      body.querySelectorAll('.score-input').forEach(inp => {
        inp.addEventListener('change', () => {
          const fixtureId = inp.dataset.fixture;
          const field = inp.dataset.field;
          const fixture = league.fixtures.find(f => f.id === fixtureId);
          if (fixture) {
            const oldVal = fixture[field];
            fixture[field] = parseInt(inp.value) || 0;
            recalcStandings(league);
            DB.updateLeague(league);
            DB.writeAudit(
              'score_updated', 'league',
              `Score: ${fixture.homeSchoolName} vs ${fixture.awaySchoolName} — ${field}: ${oldVal ?? 'blank'} → ${fixture[field]}`,
              league.id, league.name
            );
            toast('Score saved', 'success');
          }
        });
      });
    }

    // Venue assignment — master only
    if (Auth.isAdmin()) {
      body.querySelectorAll('.fixture-venue-sel').forEach(sel => {
        sel.addEventListener('change', () => {
          const fixtureId = sel.dataset.fixture;
          const fixture = league.fixtures.find(f => f.id === fixtureId);
          if (fixture) {
            fixture.venueId = sel.value;
            const v = DB.getVenues().find(v => v.id === sel.value);
            fixture.venueName = v ? v.name : 'TBA';
            DB.updateLeague(league);
            toast('Venue updated', 'success');
          }
        });
      });
    }

    const footer = document.getElementById('leagueDetailFooter');
    footer.innerHTML = `<button class="btn btn-secondary" data-modal="leagueDetailModal">Close</button>`;

    Modal.open('leagueDetailModal');
  }

  function _fixturesTab(league, schools) {
    const venues = DB.getVenues();
    const fixtures = league.fixtures || [];
    if (fixtures.length === 0) return `<p class="text-muted text-center" style="padding:1.5rem">No fixtures generated.</p>`;

    const byRound = {};
    fixtures.forEach(f => {
      const r = f.round || 1;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(f);
    });

    let html = '';
    Object.keys(byRound).sort((a,b) => a-b).forEach(r => {
      html += `<div style="margin-bottom:1rem">
        <div style="font-weight:700;font-size:.85rem;color:var(--neutral);text-transform:uppercase;margin-bottom:.5rem">Round ${r}</div>
        <table class="fixtures-table">
          <thead><tr>
            <th>Date</th><th>Home</th><th>Score</th><th>Away</th><th>Venue</th>
          </tr></thead>
          <tbody>`;
      byRound[r].forEach(f => {
        const homeSchool = schools.find(s => s.id === f.homeSchoolId);
        const awaySchool = schools.find(s => s.id === f.awaySchoolId);
        const homeColor = homeSchool ? homeSchool.color : '#666';
        const awayColor = awaySchool ? awaySchool.color : '#666';
        const hasScore = f.homeScore !== null && f.homeScore !== undefined;

        const venueOpts = Auth.isAdmin()
          ? `<select class="score-input fixture-venue-sel" style="width:auto;padding:.2rem" data-fixture="${f.id}">
              ${venues.map(v => `<option value="${v.id}"${v.id === f.venueId ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}
              <option value=""${!f.venueId ? ' selected' : ''}>TBA</option>
            </select>`
          : esc(f.venueName || 'TBA');

        const scoreCell = Auth.isLoggedIn()
          ? `<div class="score-cell">
              <input class="score-input" type="number" min="0" max="99" value="${hasScore ? f.homeScore : ''}" data-fixture="${f.id}" data-field="homeScore" style="width:40px">
              <span style="margin:0 .25rem;color:var(--neutral)">—</span>
              <input class="score-input" type="number" min="0" max="99" value="${hasScore ? f.awayScore : ''}" data-fixture="${f.id}" data-field="awayScore" style="width:40px">
            </div>`
          : hasScore ? `<strong>${f.homeScore} — ${f.awayScore}</strong>` : `<span class="text-muted">vs</span>`;

        html += `<tr>
          <td>${f.date ? formatDate(f.date) : '—'}</td>
          <td><span style="color:${homeColor}">●</span> ${esc(f.homeSchoolName)}</td>
          <td style="text-align:center">${scoreCell}</td>
          <td><span style="color:${awayColor}">●</span> ${esc(f.awaySchoolName)}</td>
          <td style="font-size:.8rem">${f.isNeutral ? '<span class="badge badge-gray">Neutral</span> ' : ''}${venueOpts}</td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    return html;
  }

  function _standingsTab(league, schools) {
    const standings = league.standings || [];
    if (standings.length === 0) return `<p class="text-muted text-center" style="padding:1.5rem">No standings yet.</p>`;

    let html = `<table class="standings-table">
      <thead><tr>
        <th class="school-color"></th>
        <th>#</th><th>School</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th>
      </tr></thead>
      <tbody>`;

    standings.forEach((row, i) => {
      const school = schools.find(s => s.id === row.schoolId);
      const color = school ? school.color : '#ccc';
      html += `<tr>
        <td class="school-color" style="background:${color}"></td>
        <td>${i + 1}</td>
        <td>${esc(row.name)}</td>
        <td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td>
        <td><strong>${row.points}</strong></td>
      </tr>`;
    });

    html += `</tbody></table>`;
    return html;
  }

  function deleteLeague(id) {
    if (!confirm('Delete this league and all its fixtures?')) return;
    const league = DB.getLeagues().find(l => l.id === id);
    DB.writeAudit('league_deleted', 'league', `Deleted league: ${league ? league.name : id}`, id, league ? league.name : null);
    DB.deleteLeague(id);
    render();
    toast('League deleted');
  }

  return { init, refresh };
})();
