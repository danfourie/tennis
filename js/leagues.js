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

  function init() {
    document.getElementById('leagueSubmitBtn').addEventListener('click', saveLeague);
    // Fixture edit modal save
    document.getElementById('fixtureEditSaveBtn').addEventListener('click', saveFixtureEdit);
    document.getElementById('fixtureEditVenue').addEventListener('change', _updateFixtureCourtList);
    render();
  }

  function refresh() {
    render();
    // If admin leagues tab is visible, refresh it too
    const adminPanel = document.getElementById('subtab-leagues');
    if (adminPanel && !adminPanel.classList.contains('hidden')) renderAdmin();
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
  // PUBLIC VIEW  (view-leagues)
  // ════════════════════════════════════════════════════════════
  function render() {
    const container = document.getElementById('leaguesList');
    if (!container) return;
    const leagues = DB.getLeagues();
    if (leagues.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><p>No leagues yet.</p></div>`;
      return;
    }
    container.innerHTML = leagues.map(l => _leagueCard(l)).join('');
    container.querySelectorAll('[data-league-view]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueDetail(btn.dataset.leagueView));
    });
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
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayLabel = l.playingDay !== undefined ? ` · ${DAYS[l.playingDay]}s` : '';

    return `<div class="card">
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
        <div class="text-muted mt-1">${totalFixtures} fixtures · ${played} played</div>
      </div>
      <div class="card-footer">
        <button class="btn btn-sm btn-secondary" data-league-view="${l.id}">View Fixtures &amp; Standings</button>
      </div>
    </div>`;
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN VIEW  (subtab-leagues inside Admin)
  // ════════════════════════════════════════════════════════════
  function renderAdmin() {
    const container = document.getElementById('adminLeaguesList');
    if (!container) return;
    const leagues = DB.getLeagues();
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

      return `<div class="admin-module-item" data-league-id="${l.id}">
        <div class="module-info">
          <div class="module-title">${esc(l.name)}</div>
          <div class="module-meta">
            ${esc(l.division || 'No division')}
            · ${l.startDate ? formatDate(l.startDate) : '?'} → ${l.endDate ? formatDate(l.endDate) : '?'}
            · ${dayLabel} · ${esc(l.matchTime || '14:00')}
          </div>
          <div class="module-meta" style="margin-top:.25rem">${teamBadges}</div>
          <div class="module-meta">${totalFixtures} fixtures · ${played} played · ${totalFixtures - played} remaining</div>
        </div>
        <div class="module-actions">
          <button class="btn btn-sm btn-secondary" data-admin-fixtures="${l.id}">📋 Manage Fixtures</button>
          <button class="btn btn-sm btn-secondary" data-admin-league-edit="${l.id}">✏️ Edit</button>
          <button class="btn btn-sm btn-danger"    data-admin-league-del="${l.id}">Delete</button>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('[data-admin-fixtures]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueDetail(btn.dataset.adminFixtures, true));
    });
    container.querySelectorAll('[data-admin-league-edit]').forEach(btn => {
      btn.addEventListener('click', () => openLeagueModal(btn.dataset.adminLeagueEdit));
    });
    container.querySelectorAll('[data-admin-league-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteLeague(btn.dataset.adminLeagueDel));
    });
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
    document.getElementById('leagueHomeMatches').value       = l ? (l.homeMatches || 1) : 1;
    document.getElementById('leaguePlayingDay').value        = l !== null ? (l.playingDay !== undefined ? l.playingDay : 5) : 5;
    document.getElementById('leagueMatchTime').value         = l ? (l.matchTime  || '14:00') : '14:00';
    document.getElementById('leagueEditId').value            = l ? l.id : '';

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

    const box = document.getElementById('leagueSchoolsCheckboxes');
    box.classList.add('checkbox-grid--teams');
    box.innerHTML = sortedSchools.map(s => {
      const count     = existingMap.get(s.id) || 0;
      const isChecked = count > 0;
      const teams     = count > 0 ? count : 1;
      return `<label class="school-select-row">
        <span class="school-check-area">
          <input type="checkbox" class="school-cb" value="${s.id}" ${isChecked ? 'checked' : ''}>
          <span style="color:${s.color}">●</span> ${esc(s.name)}${s.team ? ` <em style="color:var(--neutral);font-size:.8em">(${esc(s.team)})</em>` : ''}
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

  function saveLeague() {
    const name = document.getElementById('leagueName').value.trim();
    if (!name) { toast('League name required', 'error'); return; }

    // Build participants from checked schools + team counts
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

    if (participants.length < 2) { toast('At least 2 teams required', 'error'); return; }

    // Derived schoolIds (unique) kept for backward compat
    const schoolIds = [...new Set(participants.map(p => p.schoolId))];

    const id           = document.getElementById('leagueEditId').value;
    const homeMatches  = parseInt(document.getElementById('leagueHomeMatches').value) || 1;
    const startDate    = document.getElementById('leagueStart').value;
    const endDate      = document.getElementById('leagueEnd').value;
    const neutralVenueId = document.getElementById('leagueNeutralVenue').value || null;
    const playingDay   = parseInt(document.getElementById('leaguePlayingDay').value);
    const matchTime    = document.getElementById('leagueMatchTime').value || '14:00';

    const league = {
      id: id || uid(),
      name,
      division:      document.getElementById('leagueDivision').value.trim(),
      startDate,
      endDate,
      schoolIds,
      participants,
      homeMatches,
      neutralVenueId,
      playingDay,
      matchTime,
      fixtures:  generateFixtures(participants, homeMatches, startDate, neutralVenueId, playingDay, matchTime),
      standings: generateStandings(participants),
    };

    if (id) {
      DB.updateLeague(league);
      DB.writeAudit('league_updated', 'league', `Updated league: ${name}`, league.id, name);
      toast('League updated', 'success');
    } else {
      DB.addLeague(league);
      DB.writeAudit('league_created', 'league', `Created league: ${name} (${league.fixtures.length} fixtures)`, league.id, name);
      toast(`League created — ${league.fixtures.length} fixtures generated ✓`, 'success');
    }

    Modal.close('leagueModal');
    render();
    renderAdmin();
    Calendar.refresh();
  }

  // ════════════════════════════════════════════════════════════
  // FIXTURE GENERATION — round-robin with playing day scheduling
  // ════════════════════════════════════════════════════════════

  /**
   * @param {Array} participants  [{participantId, schoolId, teamSuffix}]
   */
  function generateFixtures(participants, homeMatchesPerPair, startDateStr, neutralVenueId, playingDay, matchTime) {
    if (!participants || participants.length < 2) return [];

    // Resolve each participant to a team object
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

    if (teams.length < 2) return [];

    const targetDay = (playingDay !== undefined && playingDay !== null) ? parseInt(playingDay) : 5;

    // Build rounds using Berger (circle) method
    const pool = [...teams];
    if (pool.length % 2 === 1) pool.push(null); // bye slot for odd count
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
      // Rotate: keep circle[0] fixed, rotate the rest clockwise
      const last = circle.splice(numTeams - 1, 1)[0];
      circle.splice(1, 0, last);
    }

    // Build full set of rounds: home + reverse (double round-robin per homeMatchesPerPair)
    const allRounds = [];
    for (let rep = 0; rep < homeMatchesPerPair; rep++) {
      singleRRRounds.forEach(round => {
        allRounds.push(round);
        allRounds.push(round.map(m => ({ home: m.away, away: m.home })));
      });
    }

    // Find first occurrence of targetDay on or after startDate
    let baseDate = startDateStr ? parseDate(startDateStr) : new Date();
    const daysAhead = (targetDay - baseDate.getDay() + 7) % 7;
    baseDate = addDays(baseDate, daysAhead);

    const fixtures = [];
    allRounds.forEach((round, roundIdx) => {
      const roundDate = addDays(baseDate, roundIdx * 7);

      round.forEach(match => {
        const homeVenue = match.home.venueId
          ? DB.getVenues().find(v => v.id === match.home.venueId)
          : null;
        const hasHome = homeVenue && (homeVenue.courts || 0) > 0;
        const venueId   = hasHome ? homeVenue.id  : (neutralVenueId || null);
        const venueName = venueId
          ? ((DB.getVenues().find(v => v.id === venueId) || {}).name || 'TBA')
          : 'TBA';

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
          isNeutral:  !hasHome,
          date:       toDateStr(roundDate),
          timeSlot:   matchTime || '14:00',
          courtIndex: 0,
          homeScore:  null,
          awayScore:  null,
          round:      roundIdx + 1,
        });
      });
    });

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
  function openLeagueDetail(id, isAdmin = false) {
    const league = DB.getLeagues().find(l => l.id === id);
    if (!league) return;
    const schools = DB.getSchools();

    document.getElementById('leagueDetailTitle').textContent = league.name;
    const body = document.getElementById('leagueDetailBody');

    recalcStandings(league);
    DB.updateLeague(league);

    body.innerHTML = `
      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="fixtures">Fixtures</button>
        <button class="modal-tab" data-tab="standings">Standings</button>
      </div>
      <div id="tab-fixtures">${_fixturesTab(league, schools, isAdmin)}</div>
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

    // Score editing — any logged-in user
    if (Auth.isLoggedIn()) {
      body.querySelectorAll('.score-input').forEach(inp => {
        inp.addEventListener('change', () => {
          const fixture = league.fixtures.find(f => f.id === inp.dataset.fixture);
          if (fixture) {
            const oldVal = fixture[inp.dataset.field];
            fixture[inp.dataset.field] = parseInt(inp.value) || 0;
            recalcStandings(league);
            DB.updateLeague(league);
            DB.writeAudit(
              'score_updated', 'league',
              `Score: ${fixture.homeSchoolName} vs ${fixture.awaySchoolName} — ${inp.dataset.field}: ${oldVal ?? 'blank'} → ${fixture[inp.dataset.field]}`,
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

      // Fixture edit buttons (admin only)
      body.querySelectorAll('[data-fixture-edit]').forEach(btn => {
        btn.addEventListener('click', () => openFixtureEdit(league.id, btn.dataset.fixtureEdit));
      });
    }

    const footer = document.getElementById('leagueDetailFooter');
    footer.innerHTML = `<button class="btn btn-secondary" data-modal="leagueDetailModal">Close</button>`;

    Modal.open('leagueDetailModal');
  }

  function _fixturesTab(league, schools, isAdmin) {
    const venues   = DB.getVenues();
    const fixtures = league.fixtures || [];
    if (fixtures.length === 0) return `<p class="text-muted text-center" style="padding:1.5rem">No fixtures generated.</p>`;

    const byRound = {};
    fixtures.forEach(f => {
      const r = f.round || 1;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(f);
    });

    let html = '';
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
        // Colour comes from the school, regardless of team suffix
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

        const scoreCell = Auth.isLoggedIn()
          ? `<div class="score-cell">
              <input class="score-input" type="number" min="0" max="99" value="${hasScore ? f.homeScore : ''}" data-fixture="${f.id}" data-field="homeScore" style="width:40px">
              <span style="margin:0 .25rem;color:var(--neutral)">—</span>
              <input class="score-input" type="number" min="0" max="99" value="${hasScore ? f.awayScore : ''}" data-fixture="${f.id}" data-field="awayScore" style="width:40px">
            </div>`
          : hasScore ? `<strong>${f.homeScore} — ${f.awayScore}</strong>` : `<span class="text-muted">vs</span>`;

        const editBtn = isAdmin
          ? `<td><button class="btn btn-xs btn-secondary" data-fixture-edit="${f.id}" title="Edit fixture">✏️</button></td>`
          : '';

        html += `<tr>
          <td style="white-space:nowrap">${f.date ? formatDate(f.date) : '—'}</td>
          <td style="white-space:nowrap">${f.timeSlot || '—'}</td>
          <td><span style="color:${homeColor}">●</span> ${esc(f.homeSchoolName)}</td>
          <td style="text-align:center">${scoreCell}</td>
          <td><span style="color:${awayColor}">●</span> ${esc(f.awaySchoolName)}</td>
          <td style="font-size:.78rem">${f.isNeutral ? '<span class="badge badge-gray">Neutral</span> ' : ''}${venueCell}</td>
          ${editBtn}
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
    Modal.open('fixtureEditModal');
  }

  function _updateFixtureCourtList(preselect) {
    const venueId = document.getElementById('fixtureEditVenue').value;
    const venue   = DB.getVenues().find(v => v.id === venueId);
    const sel     = document.getElementById('fixtureEditCourt');
    sel.innerHTML = `<option value="">Any court</option>`;
    if (venue) {
      for (let i = 0; i < (venue.courts || 0); i++) {
        const selected = (preselect !== undefined && parseInt(preselect) === i) ? ' selected' : '';
        sel.innerHTML += `<option value="${i}"${selected}>Court ${i + 1}</option>`;
      }
    }
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

    fixture.date       = newDate    || fixture.date;
    fixture.timeSlot   = newTime    || fixture.timeSlot;
    fixture.venueId    = newVenueId || null;
    fixture.venueName  = newVenueId
      ? ((DB.getVenues().find(v => v.id === newVenueId) || {}).name || 'TBA')
      : 'TBA';
    fixture.courtIndex = newCourt !== '' ? parseInt(newCourt) : null;

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
  function deleteLeague(id) {
    if (!confirm('Delete this league and all its fixtures?')) return;
    const league = DB.getLeagues().find(l => l.id === id);
    DB.writeAudit('league_deleted', 'league', `Deleted league: ${league ? league.name : id}`, id, league ? league.name : null);
    DB.deleteLeague(id);
    render();
    renderAdmin();
    toast('League deleted');
  }

  /**
   * Update a single fixture score from any module (e.g. MySchool).
   * Recalculates standings and persists to DB.
   */
  function saveScore(leagueId, fixtureId, field, rawValue) {
    const league  = DB.getLeagues().find(l => l.id === leagueId);
    if (!league) return;
    const fixture = (league.fixtures || []).find(f => f.id === fixtureId);
    if (!fixture) return;
    const oldVal  = fixture[field];
    fixture[field] = parseInt(rawValue) || 0;
    recalcStandings(league);
    DB.updateLeague(league);
    DB.writeAudit(
      'score_updated', 'league',
      `Score: ${fixture.homeSchoolName} vs ${fixture.awaySchoolName} — ${field}: ${oldVal ?? 'blank'} → ${fixture[field]}`,
      leagueId, league.name
    );
    toast('Score saved ✓', 'success');
    // Refresh any open league detail
    render();
  }

  return { init, refresh, render, renderAdmin, openLeagueModal, saveScore };
})();
