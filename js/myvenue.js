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
    // Delegate to MySchool so impersonation context is respected
    return MySchool.getActiveSchoolId();
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

    // ── Pending booking requests (always shown, even if no fixtures) ──────
    const allBookings = DB.getBookings();
    const pendingBookings = allBookings.filter(b =>
      b.status === 'pending' && b.venueId === school.venueId
    );
    html += `<div class="card" style="margin-bottom:1.5rem;border-left:4px solid var(--warning,#f59e0b)">
      <div class="card-header">
        <div class="card-title" style="margin:0">📩 Pending Booking Requests
          ${pendingBookings.length > 0 ? `<span class="badge" style="background:#fef9c3;color:#854d0e;margin-left:.5rem">${pendingBookings.length}</span>` : ''}
        </div>
      </div>
      <div class="card-body" style="padding:.25rem .75rem .75rem">`;
    if (pendingBookings.length === 0) {
      const venueBookings = allBookings.filter(b => b.venueId === school.venueId);
      const statusSummary = venueBookings.map(b => b.status || 'no-status').join(', ') || 'none';
      html += `<p class="text-muted" style="padding:.4rem 0;margin:0">No pending requests — total loaded: ${allBookings.length}, at this venue: ${venueBookings.length} (statuses: ${esc(statusSummary)})</p>`;
    } else {
      pendingBookings
        .slice()
        .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.timeSlot || '').localeCompare(b.timeSlot || ''))
        .forEach(b => {
          html += `<div class="admin-list-item" style="align-items:flex-start;gap:.75rem" data-booking-id="${esc(b.id)}">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${esc(b.label || b.type || 'Booking')}</div>
              <div class="text-muted" style="font-size:.82rem">
                📅 ${b.date ? formatDate(b.date) : '—'}
                ${b.timeSlot ? ` ⏰ ${esc(b.timeSlot)}` : ''}
                🎾 Court ${(typeof b.courtIndex === 'number') ? b.courtIndex + 1 : '—'}
              </div>
              ${b.requestedByName ? `<div class="text-muted" style="font-size:.8rem">Requested by: ${esc(b.requestedByName)}${b.schoolName ? ' · ' + esc(b.schoolName) : ''}</div>` : ''}
              ${b.notes ? `<div class="text-muted" style="font-size:.8rem;font-style:italic">${esc(b.notes)}</div>` : ''}
            </div>
            <div style="display:flex;gap:.4rem;flex-shrink:0;align-items:center">
              <button class="btn btn-sm btn-danger mv-reject-btn" data-id="${esc(b.id)}">Reject</button>
              <button class="btn btn-sm btn-primary mv-approve-btn" data-id="${esc(b.id)}">Approve ✓</button>
            </div>
          </div>`;
        });
    }
    html += `</div></div>`;

    // ── Fixtures by date ─────────────────────────────────────────
    if (sortedDates.length === 0) {
      html += `<div class="empty-state" style="margin-top:1rem">
        <div class="empty-icon">📅</div>
        <p>No ${_showUpcomingOnly ? 'upcoming ' : ''}fixtures scheduled at <strong>${esc(venue.name)}</strong>.</p>
      </div>`;
      container.innerHTML = html;
      _wireBookingHandlers(container, venue);
      return;
    }

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
    _wireBookingHandlers(container, venue);
  }

  // ── Wire approve/reject handlers after render ─────────────────
  function _wireBookingHandlers(container, venue) {
    container.querySelectorAll('.mv-approve-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const booking = DB.getBookings().find(b => b.id === id);
        btn.disabled = true; btn.textContent = 'Approving…';
        DB.approveBooking(id);
        DB.writeAudit('booking_approved', 'booking',
          `Approved request by ${booking ? esc(booking.requestedByName || 'user') : 'user'}: ${booking ? esc(booking.label || '') : ''} on ${booking ? booking.date : ''}`,
          id, booking ? booking.label || '' : '');
        if (booking && booking.requestedBy && typeof NotificationService !== 'undefined') {
          NotificationService.send({
            type:          'booking_approved',
            title:         'Booking Request Approved ✅',
            body:          `Your request to book ${esc(booking.label || venue.name)} on ${booking.date ? formatDate(booking.date) : ''} has been approved.`,
            recipientUids: [booking.requestedBy],
          });
        }
        toast('Booking approved ✓', 'success');
      });
    });

    container.querySelectorAll('.mv-reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const booking = DB.getBookings().find(b => b.id === id);
        btn.disabled = true; btn.textContent = 'Rejecting…';
        try {
          await DB.rejectBooking(id);
          DB.writeAudit('booking_rejected', 'booking',
            `Rejected request by ${booking ? esc(booking.requestedByName || 'user') : 'user'}: ${booking ? esc(booking.label || '') : ''} on ${booking ? booking.date : ''}`,
            id, booking ? booking.label || '' : '');
          if (booking && booking.requestedBy && typeof NotificationService !== 'undefined') {
            NotificationService.send({
              type:          'booking_rejected',
              title:         'Booking Request Rejected',
              body:          `Your request to book ${esc(booking.label || venue.name)} on ${booking.date ? formatDate(booking.date) : ''} has been declined.`,
              recipientUids: [booking.requestedBy],
            });
          }
          toast('Request rejected');
        } catch (err) {
          console.error('Reject booking failed:', err);
          btn.disabled = false; btn.textContent = 'Reject';
          toast('Failed to reject booking — please try again', 'error');
        }
      });
    });
  }

  return { init, refresh };
})();
