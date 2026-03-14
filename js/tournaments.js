/**
 * tournaments.js — Tournament creation and draw generation
 * Supports: Knockout, Double Elimination, Round Robin, Spider Draw
 */

const Tournaments = (() => {

  function init() {
    document.getElementById('addTournamentBtn').addEventListener('click', () => openTournamentModal());
    document.getElementById('tournamentSubmitBtn').addEventListener('click', saveTournament);
    document.getElementById('drawAddPlayersBtn').addEventListener('click', openPlayersModal);
    document.getElementById('playersSubmitBtn').addEventListener('click', savePlayers);
    populateVenueSelects();
    render();
  }

  function refresh() {
    populateVenueSelects();
    render();
  }

  function populateVenueSelects() {
    const venues = DB.getVenues();
    const opts = venues.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
    document.getElementById('tournamentVenue').innerHTML = opts || '<option value="">No venues</option>';
  }

  function render() {
    const container = document.getElementById('tournamentsList');
    const tournaments = DB.getTournaments();
    if (tournaments.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏅</div><p>No tournaments yet. Create one!</p></div>`;
      return;
    }
    container.innerHTML = tournaments.map(t => _tournamentCard(t)).join('');
    container.querySelectorAll('[data-t-view]').forEach(btn => {
      btn.addEventListener('click', () => openDrawModal(btn.dataset.tView));
    });
    container.querySelectorAll('[data-t-edit]').forEach(btn => {
      btn.addEventListener('click', () => openTournamentModal(btn.dataset.tEdit));
    });
    container.querySelectorAll('[data-t-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteTournament(btn.dataset.tDelete));
    });
  }

  function _tournamentCard(t) {
    const drawTypeLabel = { knockout: 'Knockout', roundrobin: 'Round Robin', spider: 'Spider Draw', doubleknockout: 'Double Elim.' };
    const players = t.players || [];
    const venue = DB.getVenues().find(v => v.id === t.venueId);
    return `<div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(t.name)}</div>
          <div class="text-muted">${t.category || ''}</div>
        </div>
        <span class="badge badge-blue">${drawTypeLabel[t.drawType] || t.drawType}</span>
      </div>
      <div class="card-body">
        <div class="text-muted">${t.date ? formatDate(t.date) : '—'} · ${venue ? esc(venue.name) : 'No venue'}</div>
        <div class="text-muted mt-1">${t.numPlayers} players · ${t.courtsAvailable} courts · ${t.matchDuration}min matches</div>
        <div class="text-muted mt-1">${players.filter(p => p.name).length} / ${t.numPlayers} players entered</div>
      </div>
      <div class="card-footer">
        <button class="btn btn-sm btn-secondary" data-t-view="${t.id}">View Draw</button>
        ${Auth.isAdmin() ? `<button class="btn btn-sm btn-secondary" data-t-edit="${t.id}">Edit</button>
        <button class="btn btn-sm btn-danger" data-t-delete="${t.id}">Delete</button>` : ''}
      </div>
    </div>`;
  }

  function openTournamentModal(id) {
    const t = id ? DB.getTournaments().find(x => x.id === id) : null;
    document.getElementById('tournamentModalTitle').textContent = t ? 'Edit Tournament' : 'Add Tournament';
    document.getElementById('tournamentName').value = t ? t.name : '';
    document.getElementById('tournamentDrawType').value = t ? t.drawType : 'knockout';
    document.getElementById('tournamentDate').value = t ? (t.date || '') : '';
    document.getElementById('tournamentPlayers').value = t ? t.numPlayers : 16;
    document.getElementById('tournamentCourts').value = t ? t.courtsAvailable : 4;
    document.getElementById('tournamentMatchDuration').value = t ? t.matchDuration : 60;
    document.getElementById('tournamentStartTime').value = t ? (t.startTime || '08:00') : '08:00';
    document.getElementById('tournamentCategory').value = t ? (t.category || '') : '';
    document.getElementById('tournamentEditId').value = t ? t.id : '';
    if (t && t.venueId) document.getElementById('tournamentVenue').value = t.venueId;
    Modal.open('tournamentModal');
  }

  function saveTournament() {
    const name = document.getElementById('tournamentName').value.trim();
    if (!name) { toast('Tournament name required', 'error'); return; }

    const id = document.getElementById('tournamentEditId').value;
    const numPlayers = parseInt(document.getElementById('tournamentPlayers').value) || 16;
    const courtsAvailable = parseInt(document.getElementById('tournamentCourts').value) || 4;
    const drawType = document.getElementById('tournamentDrawType').value;
    const date = document.getElementById('tournamentDate').value;
    const venueId = document.getElementById('tournamentVenue').value;
    const matchDuration = parseInt(document.getElementById('tournamentMatchDuration').value) || 60;
    const startTime = document.getElementById('tournamentStartTime').value;

    const existing = id ? DB.getTournaments().find(x => x.id === id) : null;

    const t = {
      id: id || uid(),
      name,
      drawType,
      date,
      numPlayers,
      courtsAvailable,
      matchDuration,
      startTime,
      venueId,
      category: document.getElementById('tournamentCategory').value.trim(),
      players: existing ? existing.players : _defaultPlayers(numPlayers),
    };

    // Generate draw
    t.draw = generateDraw(t);

    if (id) { DB.updateTournament(t); toast('Tournament updated', 'success'); }
    else { DB.addTournament(t); toast('Tournament created', 'success'); }

    Modal.close('tournamentModal');
    render();
  }

  function _defaultPlayers(n) {
    return Array.from({ length: n }, (_, i) => ({ id: uid(), name: '', seed: i + 1 }));
  }

  // ================================================================
  // DRAW GENERATION
  // ================================================================

  function generateDraw(t) {
    switch (t.drawType) {
      case 'knockout': return generateKnockout(t);
      case 'roundrobin': return generateRoundRobin(t);
      case 'spider': return generateSpider(t);
      case 'doubleknockout': return generateDoubleElim(t);
      default: return generateKnockout(t);
    }
  }

  /**
   * Single Elimination (Knockout)
   * Players sorted by seed; BYEs added to make power-of-2.
   * Court/time assignment: parallel matches scheduled across available courts.
   */
  function generateKnockout(t) {
    const players = _seededPlayers(t.players, t.numPlayers);
    const size = nextPow2(players.length);
    const padded = [...players];
    while (padded.length < size) padded.push({ id: uid(), name: 'BYE', seed: null, bye: true });

    // Build seeded draw (1 vs size, 2 vs size-1...)
    const seededOrder = buildSeededBracket(padded);
    const rounds = Math.log2(size);
    const roundNames = _knockoutRoundNames(rounds);

    // Round 1 matches
    const r1Matches = [];
    for (let i = 0; i < size; i += 2) {
      r1Matches.push({
        id: uid(),
        round: 1,
        matchNum: r1Matches.length + 1,
        p1: seededOrder[i],
        p2: seededOrder[i + 1],
        winner: null,
        score: null,
        court: null,
        scheduledTime: null,
      });
    }

    // Assign courts and times to R1
    _assignCourtsTime(r1Matches, t);

    // Build skeleton for subsequent rounds
    const allRounds = [r1Matches];
    let prevRound = r1Matches;
    for (let r = 2; r <= rounds; r++) {
      const rMatches = [];
      for (let i = 0; i < prevRound.length; i += 2) {
        rMatches.push({
          id: uid(),
          round: r,
          matchNum: rMatches.length + 1,
          p1: null, p2: null,
          prevMatchIds: [prevRound[i].id, prevRound[i + 1] ? prevRound[i + 1].id : null],
          winner: null,
          score: null,
          court: null,
          scheduledTime: null,
        });
      }
      allRounds.push(rMatches);
      prevRound = rMatches;
    }

    // Auto-advance BYEs
    _autoAdvanceByes(allRounds);

    return {
      type: 'knockout',
      rounds: allRounds,
      roundNames,
      size,
    };
  }

  /**
   * Double Elimination
   */
  function generateDoubleElim(t) {
    // Generate winner bracket same as knockout, then note it's double elim
    const ko = generateKnockout(t);
    ko.type = 'doubleknockout';
    // Build a simple loser bracket skeleton
    const r1 = ko.rounds[0];
    const loserMatches = r1.map((m, i) => ({
      id: uid(),
      round: 1,
      bracket: 'loser',
      matchNum: i + 1,
      p1: null, p2: null,
      fromWinnerMatchId: m.id,
      winner: null, score: null, court: null, scheduledTime: null,
    }));
    ko.loserBracket = [loserMatches];
    return ko;
  }

  /**
   * Round Robin — every player plays every other player.
   * Uses circle method for schedule.
   */
  function generateRoundRobin(t) {
    const players = _seededPlayers(t.players, t.numPlayers);
    const n = players.length;
    const list = [...players];
    if (n % 2 !== 0) list.push({ id: uid(), name: 'BYE', seed: null, bye: true });
    const total = list.length;
    const rounds = total - 1;
    const allRounds = [];

    for (let r = 0; r < rounds; r++) {
      const matches = [];
      for (let i = 0; i < total / 2; i++) {
        const p1 = list[i];
        const p2 = list[total - 1 - i];
        if (!p1.bye && !p2.bye) {
          matches.push({
            id: uid(),
            round: r + 1,
            matchNum: matches.length + 1,
            p1, p2,
            winner: null, score: null, court: null, scheduledTime: null,
          });
        }
      }
      _assignCourtsTime(matches, t, r);
      allRounds.push(matches);

      // Rotate: fix first, rotate rest
      const last = list.splice(total - 1, 1)[0];
      list.splice(1, 0, last);
    }

    // Build grid for display
    const grid = _buildRRGrid(players, allRounds.flat());

    return { type: 'roundrobin', rounds: allRounds, players, grid };
  }

  function _buildRRGrid(players, matches) {
    const grid = {};
    players.forEach(p => { grid[p.id] = {}; });
    matches.forEach(m => {
      if (!grid[m.p1.id]) grid[m.p1.id] = {};
      if (!grid[m.p2.id]) grid[m.p2.id] = {};
      grid[m.p1.id][m.p2.id] = { matchId: m.id, score: m.score, winner: m.winner };
      grid[m.p2.id][m.p1.id] = { matchId: m.id, score: m.score ? m.score.split('-').reverse().join('-') : null, winner: m.winner };
    });
    return grid;
  }

  /**
   * Spider Draw
   * Players are divided into groups; top players from each group advance to a finals knockout.
   * Group size: ~4 players each. Groups play round-robin internally.
   */
  function generateSpider(t) {
    const players = _seededPlayers(t.players, t.numPlayers);
    const groupSize = 4;
    const numGroups = Math.ceil(players.length / groupSize);
    const groups = [];

    for (let g = 0; g < numGroups; g++) {
      const groupPlayers = players.slice(g * groupSize, (g + 1) * groupSize);
      const matches = [];
      for (let i = 0; i < groupPlayers.length; i++) {
        for (let j = i + 1; j < groupPlayers.length; j++) {
          matches.push({
            id: uid(),
            group: g,
            matchNum: matches.length + 1,
            p1: groupPlayers[i],
            p2: groupPlayers[j],
            winner: null, score: null, court: null, scheduledTime: null,
          });
        }
      }
      _assignCourtsTime(matches, t, g);
      groups.push({ id: g, name: `Group ${String.fromCharCode(65 + g)}`, players: groupPlayers, matches });
    }

    // Finals placeholder (top 1 from each group → knockout)
    const finalistsCount = nextPow2(numGroups);
    const finalsMatches = [];
    for (let i = 0; i < finalistsCount; i += 2) {
      finalsMatches.push({
        id: uid(),
        round: 'Final',
        matchNum: finalsMatches.length + 1,
        p1: null, p2: null,
        fromGroups: [i, i + 1],
        winner: null, score: null, court: null, scheduledTime: null,
      });
    }

    return { type: 'spider', groups, finalsMatches };
  }

  // ================================================================
  // COURT / TIME ASSIGNMENT
  // ================================================================

  function _assignCourtsTime(matches, t, roundOffset = 0) {
    const courts = t.courtsAvailable || 4;
    const duration = t.matchDuration || 60;
    const [sh, sm] = (t.startTime || '08:00').split(':').map(Number);
    let startMins = sh * 60 + sm + roundOffset * duration;

    matches.forEach((m, i) => {
      const court = (i % courts) + 1;
      const slotOffset = Math.floor(i / courts);
      const mins = startMins + slotOffset * duration;
      const h = Math.floor(mins / 60) % 24;
      const min = mins % 60;
      m.court = court;
      m.scheduledTime = `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    });
  }

  // ================================================================
  // BRACKET HELPERS
  // ================================================================

  function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  function _seededPlayers(players, numPlayers) {
    const filled = (players || []).filter(p => p.name).slice(0, numPlayers);
    const blanks = numPlayers - filled.length;
    for (let i = 0; i < blanks; i++) filled.push({ id: uid(), name: `Player ${filled.length + 1}`, seed: filled.length + 1 });
    return filled.map((p, i) => ({ ...p, seed: p.seed || i + 1 }));
  }

  /**
   * Build seeded bracket order (standard tennis seeding).
   * 1 vs (n), 2 vs (n-1) with randomized placement in halves.
   */
  function buildSeededBracket(players) {
    const n = players.length;
    const order = new Array(n).fill(null);
    // Place seeds in bracket positions
    order[0] = players[0]; // seed 1 top
    order[n - 1] = players[1]; // seed 2 bottom

    // Seeds 3 & 4 placed randomly in quartets
    if (n >= 4) {
      const pos34 = Math.random() < .5 ? [n/2 - 1, n/2] : [n/2, n/2 - 1];
      order[pos34[0]] = players[2];
      order[pos34[1]] = players[3];
    }

    // Fill remaining spots with unseeded players
    const unseeded = players.slice(4).filter(p => !p.bye).concat(players.filter(p => p.bye));
    let ui = 0;
    for (let i = 0; i < n; i++) {
      if (!order[i]) { order[i] = unseeded[ui++] || { id: uid(), name: 'BYE', seed: null, bye: true }; }
    }
    return order;
  }

  function _autoAdvanceByes(allRounds) {
    allRounds[0].forEach(m => {
      if (m.p2 && m.p2.bye) { m.winner = m.p1; m.score = 'BYE'; }
      else if (m.p1 && m.p1.bye) { m.winner = m.p2; m.score = 'BYE'; }
    });
    for (let r = 1; r < allRounds.length; r++) {
      const prevRound = allRounds[r - 1];
      const matchMap = {};
      prevRound.forEach(m => { matchMap[m.id] = m; });
      allRounds[r].forEach(m => {
        if (m.prevMatchIds) {
          const pm1 = matchMap[m.prevMatchIds[0]];
          const pm2 = matchMap[m.prevMatchIds[1]];
          if (pm1 && pm1.winner) m.p1 = pm1.winner;
          if (pm2 && pm2.winner) m.p2 = pm2.winner;
          if (m.p2 && m.p2.bye) { m.winner = m.p1; m.score = 'BYE'; }
          else if (m.p1 && m.p1.bye) { m.winner = m.p2; m.score = 'BYE'; }
        }
      });
    }
  }

  function _knockoutRoundNames(totalRounds) {
    const names = {};
    const roundLabels = ['Final', 'Semi-Final', 'Quarter-Final', 'Round of 16', 'Round of 32', 'Round of 64', 'Round of 128'];
    for (let r = totalRounds; r >= 1; r--) {
      names[r] = roundLabels[totalRounds - r] || `Round ${r}`;
    }
    return names;
  }

  // ================================================================
  // DRAW MODAL
  // ================================================================

  let _currentTournamentId = null;

  function openDrawModal(id) {
    _currentTournamentId = id;
    const t = DB.getTournaments().find(x => x.id === id);
    if (!t) return;

    document.getElementById('drawModalTitle').textContent = t.name + ' — Draw';
    const body = document.getElementById('drawModalBody');

    const venue = DB.getVenues().find(v => v.id === t.venueId);
    const drawTypeLabel = { knockout: 'Knockout', roundrobin: 'Round Robin', spider: 'Spider Draw', doubleknockout: 'Double Elimination' };

    let metaHtml = `
      <div class="draw-meta">
        <span class="badge badge-blue">${drawTypeLabel[t.drawType]}</span>
        ${t.date ? `<span class="badge badge-gray">${formatDate(t.date)}</span>` : ''}
        ${venue ? `<span class="badge badge-gray">📍 ${esc(venue.name)}</span>` : ''}
        <span class="badge badge-gray">${t.numPlayers} players</span>
        <span class="badge badge-gray">${t.courtsAvailable} courts</span>
        <span class="badge badge-gray">${t.matchDuration}min/match</span>
      </div>`;

    let drawHtml = '';
    const draw = t.draw;
    if (!draw) {
      drawHtml = `<p class="text-muted text-center">No draw generated yet.</p>`;
    } else if (draw.type === 'knockout' || draw.type === 'doubleknockout') {
      drawHtml = _renderKnockoutDraw(draw, t);
    } else if (draw.type === 'roundrobin') {
      drawHtml = _renderRoundRobinDraw(draw, t);
    } else if (draw.type === 'spider') {
      drawHtml = _renderSpiderDraw(draw, t);
    }

    body.innerHTML = `<div class="draw-container">${metaHtml}${drawHtml}</div>`;

    // Score editing
    if (Auth.isAdmin()) {
      body.querySelectorAll('.match-score-input').forEach(inp => {
        inp.addEventListener('change', () => _saveMatchScore(t, inp));
      });
    }

    // Show admin edit players button
    const editBtn = document.getElementById('drawAddPlayersBtn');
    editBtn.classList.toggle('hidden', !Auth.isAdmin());

    Modal.open('drawModal');
  }

  function _renderKnockoutDraw(draw, t) {
    const rounds = draw.rounds;
    let html = `<div class="knockout-bracket">`;

    rounds.forEach((round, ri) => {
      const roundName = draw.roundNames ? draw.roundNames[ri + 1] : `Round ${ri + 1}`;
      html += `<div class="bracket-round">
        <div class="bracket-round-title">${roundName}</div>
        <div class="bracket-matches">`;

      round.forEach(m => {
        const p1Name = m.p1 ? esc(m.p1.name) : '?';
        const p2Name = m.p2 ? esc(m.p2.name) : '?';
        const p1Win = m.winner && m.p1 && m.winner.id === m.p1.id;
        const p2Win = m.winner && m.p2 && m.winner.id === m.p2.id;
        const p1Bye = m.p1 && m.p1.bye;
        const p2Bye = m.p2 && m.p2.bye;

        const scoreDisplay = m.score && m.score !== 'BYE'
          ? Auth.isAdmin()
            ? `<input class="match-score-input editable-score" value="${m.score}" data-match="${m.id}" data-tournament="${t.id}" data-bracket="main" style="width:60px;text-align:center">`
            : `<span>${m.score}</span>`
          : m.score === 'BYE' ? '' : Auth.isAdmin()
            ? `<input class="match-score-input editable-score" value="" placeholder="6-4" data-match="${m.id}" data-tournament="${t.id}" data-bracket="main" style="width:60px;text-align:center">`
            : '';

        html += `<div class="bracket-match-wrapper">
          <div class="bracket-match">
            <div class="bracket-player${p1Win ? ' winner' : ''}${p1Bye ? ' bye' : ''}">
              <span>${m.p1 && m.p1.seed ? `<sup class="seed-badge">${m.p1.seed}</sup>` : ''}${p1Name}</span>
            </div>
            <div class="bracket-player${p2Win ? ' winner' : ''}${p2Bye ? ' bye' : ''}">
              <span>${m.p2 && m.p2.seed ? `<sup class="seed-badge">${m.p2.seed}</sup>` : ''}${p2Name}</span>
            </div>
            ${m.court ? `<div class="bracket-court">Court ${m.court} · ${m.scheduledTime || ''} ${scoreDisplay}</div>` : ''}
          </div>
        </div>`;
      });

      html += `</div></div>`;
    });

    html += `</div>`;

    // Schedule table
    html += _renderScheduleTable(rounds.flat());
    return html;
  }

  function _renderRoundRobinDraw(draw, t) {
    const players = draw.players || [];
    const allMatches = (draw.rounds || []).flat();

    // Grid
    let gridHtml = `<div class="rr-container"><table class="rr-table">
      <thead><tr><th>Player</th>${players.map(p => `<th>${esc(p.name || '?')}</th>`).join('')}</tr></thead>
      <tbody>`;

    players.forEach(rowP => {
      gridHtml += `<tr><td class="rr-row-header">${rowP.seed ? `<sup>${rowP.seed}</sup>` : ''}${esc(rowP.name || '?')}</td>`;
      players.forEach(colP => {
        if (rowP.id === colP.id) {
          gridHtml += `<td class="rr-self">—</td>`;
        } else {
          const match = allMatches.find(m =>
            (m.p1.id === rowP.id && m.p2.id === colP.id) ||
            (m.p1.id === colP.id && m.p2.id === rowP.id)
          );
          if (!match) { gridHtml += `<td>—</td>`; return; }
          const isP1 = match.p1.id === rowP.id;
          const score = match.score;
          const won = match.winner && match.winner.id === rowP.id;
          const lost = match.winner && match.winner.id !== rowP.id;
          const cls = won ? 'rr-win' : lost ? 'rr-loss' : '';
          const displayScore = score ? (isP1 ? score : score.split('-').reverse().join('-')) : '—';
          gridHtml += `<td class="${cls}">${displayScore}</td>`;
        }
      });
      gridHtml += `</tr>`;
    });

    gridHtml += `</tbody></table></div>`;
    gridHtml += _renderScheduleTable(allMatches);
    return gridHtml;
  }

  function _renderSpiderDraw(draw, t) {
    let html = `<div class="spider-draw">`;

    // Groups
    draw.groups.forEach(g => {
      html += `<div class="spider-group">
        <div class="spider-group-header">
          <span>${esc(g.name)}</span>
          <span class="text-muted" style="font-weight:normal;font-size:.8rem">${g.players.length} players</span>
        </div>
        <div class="spider-matches">`;

      g.matches.forEach(m => {
        const p1 = m.p1, p2 = m.p2;
        const scored = m.score && m.score !== 'BYE';
        const scoreField = Auth.isAdmin()
          ? `<input class="match-score-input editable-score" value="${m.score || ''}" placeholder="6-4" data-match="${m.id}" data-tournament="${t.id}" data-bracket="spider" data-group="${g.id}">`
          : `<span>${m.score || '—'}</span>`;

        html += `<div class="spider-match">
          <span>${p1 ? esc(p1.name) : '?'}</span>
          <span class="vs">vs</span>
          <span>${p2 ? esc(p2.name) : '?'}</span>
          <span class="court-info">C${m.court||'?'} ${m.scheduledTime||''} ${scoreField}</span>
        </div>`;
      });

      html += `</div></div>`;
    });

    // Finals
    if (draw.finalsMatches && draw.finalsMatches.length > 0) {
      html += `<div class="spider-group">
        <div class="spider-group-header"><span>Finals (Top from each group)</span></div>
        <div class="spider-matches">`;
      draw.finalsMatches.forEach(m => {
        html += `<div class="spider-match">
          <span>${m.p1 ? esc(m.p1.name) : 'Winner Grp '+((m.fromGroups||[])[0]+1 || '?')}</span>
          <span class="vs">vs</span>
          <span>${m.p2 ? esc(m.p2.name) : 'Winner Grp '+((m.fromGroups||[])[1]+1 || '?')}</span>
          <span class="court-info">${m.court ? 'C'+m.court : ''} ${m.scheduledTime||''}</span>
        </div>`;
      });
      html += `</div></div>`;
    }

    html += `</div>`;
    return html;
  }

  function _renderScheduleTable(matches) {
    const matchesWithCourt = matches.filter(m => m.court && !m.p1?.bye && !m.p2?.bye);
    if (matchesWithCourt.length === 0) return '';

    let html = `<div style="margin-top:1.25rem">
      <div style="font-weight:700;font-size:.9rem;margin-bottom:.5rem">Match Schedule</div>
      <table class="schedule-table">
        <thead><tr><th>#</th><th>Time</th><th>Court</th><th>Player 1</th><th>vs</th><th>Player 2</th><th>Score</th></tr></thead>
        <tbody>`;

    matchesWithCourt.sort((a,b) => (a.scheduledTime||'').localeCompare(b.scheduledTime||'') || a.court - b.court)
      .forEach((m, i) => {
        const p1 = m.p1 ? esc(m.p1.name) : '?';
        const p2 = m.p2 ? esc(m.p2.name) : '?';
        html += `<tr>
          <td class="match-num">${i+1}</td>
          <td>${m.scheduledTime||'—'}</td>
          <td>Court ${m.court}</td>
          <td>${p1}</td>
          <td style="text-align:center;color:var(--neutral)">vs</td>
          <td>${p2}</td>
          <td>${m.score && m.score !== 'BYE' ? m.score : '—'}</td>
        </tr>`;
      });

    html += `</tbody></table></div>`;
    return html;
  }

  function _saveMatchScore(t, inp) {
    const matchId = inp.dataset.match;
    const bracket = inp.dataset.bracket;
    const score = inp.value.trim();
    const draw = t.draw;

    if (bracket === 'spider') {
      const groupId = parseInt(inp.dataset.group);
      const group = draw.groups.find(g => g.id === groupId);
      if (group) {
        const match = group.matches.find(m => m.id === matchId);
        if (match) {
          match.score = score;
          const [s1, s2] = score.split('-').map(Number);
          if (!isNaN(s1) && !isNaN(s2)) {
            match.winner = s1 > s2 ? match.p1 : match.p2;
          }
        }
      }
    } else {
      // Knockout / RR — search all rounds
      const allMatches = (draw.rounds || []).flat().concat((draw.loserBracket || []).flat());
      const match = allMatches.find(m => m.id === matchId);
      if (match) {
        match.score = score;
        const [s1, s2] = score.split('-').map(Number);
        if (!isNaN(s1) && !isNaN(s2)) {
          match.winner = s1 > s2 ? match.p1 : match.p2;
          // Propagate to next match
          _propagateWinner(draw.rounds, match);
        }
      }
    }

    DB.updateTournament(t);
    toast('Score saved', 'success');
  }

  function _propagateWinner(rounds, match) {
    if (!match.winner) return;
    for (let r = 0; r < rounds.length; r++) {
      const found = rounds[r].find(m => m.id === match.id);
      if (found && r + 1 < rounds.length) {
        // Find which next-round match references this one
        const nextMatch = rounds[r + 1].find(m =>
          m.prevMatchIds && m.prevMatchIds.includes(match.id)
        );
        if (nextMatch) {
          if (nextMatch.prevMatchIds[0] === match.id) nextMatch.p1 = match.winner;
          else nextMatch.p2 = match.winner;
          // Auto-advance BYE
          if (nextMatch.p2 && nextMatch.p2.bye) { nextMatch.winner = nextMatch.p1; nextMatch.score = 'BYE'; _propagateWinner(rounds, nextMatch); }
          else if (nextMatch.p1 && nextMatch.p1.bye) { nextMatch.winner = nextMatch.p2; nextMatch.score = 'BYE'; _propagateWinner(rounds, nextMatch); }
        }
        break;
      }
    }
  }

  // ================================================================
  // PLAYERS MODAL
  // ================================================================

  function openPlayersModal() {
    const t = DB.getTournaments().find(x => x.id === _currentTournamentId);
    if (!t) return;

    const body = document.getElementById('playersModalBody');
    const players = t.players || _defaultPlayers(t.numPlayers);

    let html = `<p class="text-muted" style="margin-bottom:.75rem">Enter player names and seeds. Leave blank for TBD.</p>
      <div class="players-list">
        <div class="player-row" style="font-size:.78rem;font-weight:700;color:var(--neutral)">
          <span style="min-width:24px">Seed</span>
          <span style="flex:1">Name</span>
          <span style="width:70px">Rating</span>
          <span style="width:28px"></span>
        </div>`;

    players.forEach((p, i) => {
      html += `<div class="player-row" data-idx="${i}">
        <span class="seed-badge">${i + 1}</span>
        <input type="text" class="p-name" value="${esc(p.name || '')}" placeholder="Player ${i + 1}" data-id="${p.id}">
        <input type="number" class="p-rating" value="${p.rating || ''}" placeholder="Rating" min="0">
        <button class="remove-player" data-idx="${i}">×</button>
      </div>`;
    });

    html += `</div>
      <button class="btn btn-sm btn-secondary" id="addPlayerRow" style="margin-top:.75rem">+ Add Player</button>`;

    body.innerHTML = html;

    body.querySelectorAll('.remove-player').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        btn.closest('.player-row').remove();
      });
    });

    document.getElementById('addPlayerRow').addEventListener('click', () => {
      const list = body.querySelector('.players-list');
      const rows = list.querySelectorAll('.player-row[data-idx]');
      const nextSeed = rows.length + 1;
      const div = document.createElement('div');
      div.className = 'player-row';
      div.dataset.idx = nextSeed - 1;
      div.innerHTML = `<span class="seed-badge">${nextSeed}</span>
        <input type="text" class="p-name" placeholder="Player ${nextSeed}" data-id="${uid()}">
        <input type="number" class="p-rating" placeholder="Rating" min="0">
        <button class="remove-player" data-idx="${nextSeed - 1}">×</button>`;
      div.querySelector('.remove-player').addEventListener('click', () => div.remove());
      list.appendChild(div);
    });

    Modal.open('playersModal');
  }

  function savePlayers() {
    const t = DB.getTournaments().find(x => x.id === _currentTournamentId);
    if (!t) return;

    const rows = document.querySelectorAll('#playersModalBody .player-row[data-idx]');
    const players = [];
    rows.forEach((row, i) => {
      const nameInput = row.querySelector('.p-name');
      const ratingInput = row.querySelector('.p-rating');
      players.push({
        id: nameInput.dataset.id || uid(),
        name: nameInput.value.trim(),
        seed: i + 1,
        rating: parseFloat(ratingInput.value) || null,
      });
    });

    t.players = players;
    t.numPlayers = players.length;
    t.draw = generateDraw(t);
    DB.updateTournament(t);

    Modal.close('playersModal');
    openDrawModal(t.id);
    toast('Players saved & draw regenerated', 'success');
  }

  function deleteTournament(id) {
    if (!confirm('Delete this tournament?')) return;
    DB.deleteTournament(id);
    render();
    toast('Tournament deleted');
  }

  return { init, refresh };
})();
