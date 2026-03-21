/**
 * myvenue.js — "My Venue" view.
 *
 * Shows every fixture scheduled at the school's home venue across all
 * leagues, grouped by date.  Overloaded dates (total courtsBooked >
 * venue.courts) are highlighted in red so the organiser can spot
 * scheduling conflicts at a glance and make adjustments.
 */

const MyVenue = (() => {

  // ── state ────────────────────────────────────────────────────
  let _showUpcomingOnly = false;   // toggle: all | upcoming

  // ── helpers ─────────────────────────────────────────────────
  function _activeSchoolId() {
    const profile = Auth.getProfile();
    return profile ? profile.schoolId : null;
  }

  // ── nav button ───────────────────────────────────────────────
  function _syncNav() {
    const btn = document.querySelector('[data-view="myvenue"]');
    if (!btn) return;
    const schoolId = _activeSchoolId();
    const school   = schoolId ? DB.getSchools().find(s => s.id === schoolId) : null;
    const hasVenue = Auth.isLoggedIn() && school && !!school.venueId;
    btn.classList.toggle('hidden', !hasVenue);
    if (!hasVenue) {
      const view = document.getElementById('view-myvenue');
      if (view && !view.classList.contains('hidden')) {
        document.querySelector('[data-view="calendar"]')?.click();
      }
    }
  }

  // ── toggle buttons ───────────────────────────────────────────
  function _syncToggleBtns() {
    const btnAll      = document.getElementById('mvViewAll');
    const btnUpcoming = document.getElementById('mvViewUpcoming');
    if (!btnAll || !btnUpcoming) return;
    btnAll     .className = `btn btn-sm ${!_showUpcomingOnly ? 'btn-primary' : 'btn-secondary'}`;
    btnUpcoming.className = `btn btn-sm ${_showUpcomingOnly  ? 'btn-primary' : 'btn-secondary'}`;
  }

  // ── public API ───────────────────────────────────────────────
  function init() {
    const btnAll      = document.getElementById('mvViewAll');
    const btnUpcoming = document.getElementById('mvViewUpcoming');
    if (btnAll) {
      btnAll.addEventListener('click', () => {
        _showUpcomingOnly = false;
        _syncToggleBtns();
        _render();
      });
    }
    if (btnUpcoming) {
      btnUpcoming.addEventListener('click', () => {
        _showUpcomingOnly = true;
        _syncToggleBtns();
        _render();
      });
    }
  }

  function refresh() {
    _syncNav();
    const view = document.getElementById('view-myvenue');
    if (view && !view.classList.contains('hidden')) _render();
  }

  // ── main render ──────────────────────────────────────────────
  function _render() {
    const container = document.getElementById('myvenueContent');
    if (!container) return;

    _syncToggleBtns();

    const schoolId = _activeSchoolId();
    if (!schoolId) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏟</div>
        <p>No school linked to your account. Contact an admin.</p>
      </div>`;
      return;
    }

    const school = DB.getSchools().find(s => s.id === schoolId);
    if (!school || !school.venueId) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏟</div>
        <p>No home venue configured for your school.<br>
           Ask an admin to set a home venue for your school.</p>
      </div>`;
      return;
    }

    const venue = DB.getVenues().find(v => v.id === school.venueId);
    if (!venue) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏟</div>
        <p>Venue not found. Contact an admin.</p>
      </div>`;
      return;
    }

    // Update page heading
    const title = document.getElementById('myvenueTitle');
    if (title) title.textContent = venue.name;

    const totalCourts = venue.courts || 0;
    const today       = new Date().toISOString().slice(0, 10);

    // Collect all fixtures at this venue across every league
    const allLeagues = DB.getLeagues();
    const fixturesByDate = new Map(); // date → [{fixture, league}]

    allLeagues.forEach(league => {
      (league.fixtures || []).forEach(f => {
        if (f.venueId !== school.venueId) return;
        if (_showUpcomingOnly && f.date && f.date < today) return;
        if (!fixturesByDate.has(f.date)) fixturesByDate.set(f.date, []);
        fixturesByDate.get(f.date).push({ fixture: f, league });
      });
    });

    if (fixturesByDate.size === 0) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>No ${_showUpcomingOnly ? 'upcoming ' : ''}fixtures scheduled at <strong>${esc(venue.name)}</strong>.</p>
      </div>`;
      return;
    }

    // Sort dates
    const sortedDates = [...fixturesByDate.keys()].sort();

    // Venue header
    let html = `<div class="myschool-header">
      <div style="font-size:2rem">🏟</div>
      <div>
        <div class="myschool-school-name">${esc(venue.name)}</div>
        ${venue.address ? `<div class="text-muted">📍 ${esc(venue.address)}</div>` : ''}
        ${totalCourts  ? `<div class="text-muted">🎾 ${totalCourts} court${totalCourts !== 1 ? 's' : ''} available</div>` : ''}
        <div class="text-muted">Home venue for: <strong>${esc(school.name)}</strong></div>
      </div>
    </div>`;

    // One card per date
    sortedDates.forEach(date => {
      const entries   = fixturesByDate.get(date);
      const booked    = entries.reduce((sum, e) => sum + (e.fixture.courtsBooked || 3), 0);
      const isOver    = totalCourts > 0 && booked > totalCourts;
      const isNear    = totalCourts > 0 && !isOver && booked >= totalCourts;
      const isPast    = date && date < today;

      const statusColor = isOver ? 'var(--danger, #ef4444)'
                        : isNear ? 'var(--warning, #f59e0b)'
                        : 'var(--success, #22c55e)';
      const statusLabel = isOver ? `⚠️ Overbooked — ${booked} / ${totalCourts} courts`
                        : isNear ? `⚠️ Full — ${booked} / ${totalCourts} courts`
                        : totalCourts ? `✓ ${booked} / ${totalCourts} courts`
                        : `${booked} courts booked`;

      html += `<div class="card" style="margin-bottom:1rem;border-left:4px solid ${statusColor}${isPast ? ';opacity:.7' : ''}">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem">
          <div>
            <div class="card-title" style="margin:0">
              📅 ${date ? formatDate(date) : '—'}
              ${isPast ? '<span class="badge badge-gray" style="margin-left:.5rem;font-size:.7rem">Past</span>' : ''}
            </div>
            <div class="text-muted" style="font-size:.82rem">${entries.length} fixture${entries.length !== 1 ? 's' : ''}</div>
          </div>
          <span style="font-size:.82rem;font-weight:600;color:${statusColor}">${statusLabel}</span>
        </div>
        <div class="card-body" style="padding:.25rem .75rem .75rem">`;

      // Sort fixtures on this date by time then league name
      const sorted = [...entries].sort((a, b) => {
        const tA = a.fixture.timeSlot || a.fixture.matchTime || '';
        const tB = b.fixture.timeSlot || b.fixture.matchTime || '';
        return tA.localeCompare(tB) || a.league.name.localeCompare(b.league.name);
      });

      sorted.forEach(({ fixture: f, league }) => {
        const hasScore   = f.homeScore !== null && f.homeScore !== undefined;
        const courts     = f.courtsBooked || 3;
        const courtLabel = courts === 1 ? '1 court' : `${courts} courts`;

        const homeSchool = DB.getSchools().find(s => s.id === f.homeSchoolId);
        const awaySchool = DB.getSchools().find(s => s.id === f.awaySchoolId);
        const hColor     = homeSchool ? homeSchool.color : '#666';
        const aColor     = awaySchool ? awaySchool.color : '#666';

        let scoreHtml;
        if (hasScore) {
          scoreHtml = `<strong>${f.homeScore} — ${f.awayScore}</strong>`;
        } else {
          scoreHtml = `<span class="text-muted">vs</span>`;
        }

        html += `<div class="myschool-fixture" style="margin:.5rem 0;background:var(--surface2,#f8fafc);border-radius:6px;padding:.5rem .75rem">
          <div class="fixture-meta" style="margin-bottom:.2rem">
            <span class="text-muted" style="font-size:.78rem">🏆 ${esc(league.name)}${league.division ? ' · ' + esc(league.division) : ''}</span>
            ${f.timeSlot ? `<span class="text-muted" style="font-size:.78rem">⏰ ${esc(f.timeSlot)}</span>` : ''}
            <span class="text-muted" style="font-size:.78rem">🎾 ${courtLabel}</span>
          </div>
          <div class="fixture-score-row">
            <span class="fixture-team">
              <span style="color:${hColor}">●</span> ${esc(f.homeSchoolName)}
            </span>
            <span class="fixture-score">${scoreHtml}</span>
            <span class="fixture-team">
              <span style="color:${aColor}">●</span> ${esc(f.awaySchoolName)}
            </span>
          </div>
        </div>`;
      });

      html += `</div></div>`;
    });

    container.innerHTML = html;
  }

  return { init, refresh };
})();
