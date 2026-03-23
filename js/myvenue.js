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
    let html = `<div class="myschool-header" style="justify-content:space-between;align-items:flex-start">
      <div style="display:flex;gap:.75rem;align-items:flex-start">
        <div style="font-size:2rem;line-height:1">🏟</div>
        <div>
          <div class="myschool-school-name">${esc(venue.name)}</div>
          ${venue.address ? `<div class="text-muted">📍 ${esc(venue.address)}</div>` : ''}
          ${totalCourts  ? `<div class="text-muted">🎾 ${totalCourts} court${totalCourts !== 1 ? 's' : ''} available</div>` : ''}
          <div class="text-muted">Home venue for: <strong>${esc(school.name)}</strong></div>
        </div>
      </div>
      <button class="btn btn-sm btn-secondary" id="mv-settings-shortcut"
          title="Open school &amp; venue settings" style="flex-shrink:0;white-space:nowrap">
        ⚙️ Settings
      </button>
    </div>`;

    // ── All bookings at this venue (excluding rejected) ──────────────────────
    // Confirmed bookings are shown with a "Cancel" button so plans can be
    // reversed.  Only truly rejected bookings are hidden.
    const allBookings  = DB.getBookings();
    const venueBookings = allBookings
      .filter(b => b.venueId === school.venueId && b.status !== 'rejected')
      .slice()
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.timeSlot || '').localeCompare(b.timeSlot || ''));
    const pendingCount  = venueBookings.filter(b => b.status !== 'confirmed').length;
    const borderColor   = pendingCount > 0 ? 'var(--warning,#f59e0b)' : 'var(--success,#22c55e)';

    html += `<div class="card" style="margin-bottom:1.5rem;border-left:4px solid ${borderColor}">
      <div class="card-header">
        <div class="card-title" style="margin:0">📩 Venue Bookings
          ${pendingCount > 0 ? `<span class="badge" style="background:#fef9c3;color:#854d0e;margin-left:.5rem">${pendingCount} awaiting confirmation</span>` : `<span class="badge" style="background:#dcfce7;color:#166534;margin-left:.5rem">All confirmed ✓</span>`}
        </div>
      </div>
      <div class="card-body" style="padding:.25rem .75rem .75rem">`;

    if (venueBookings.length === 0) {
      html += `<p class="text-muted" style="padding:.4rem 0;margin:0">No bookings recorded for this venue yet.</p>`;
    } else {
      venueBookings.forEach(b => {
        const isConfirmed = b.status === 'confirmed';
        const isPending   = b.status === 'pending';
        // Badge colour: green = confirmed, yellow = pending request, blue = admin-scheduled
        const statusBadge = isConfirmed
          ? `<span class="badge" style="background:#dcfce7;color:#166534;font-size:.7rem">Confirmed ✓</span>`
          : isPending
            ? `<span class="badge" style="background:#fef9c3;color:#854d0e;font-size:.7rem">Request</span>`
            : `<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:.7rem">Admin-scheduled</span>`;

        // Confirmed bookings only need a "Cancel" button; unconfirmed get Approve+Reject.
        const actionBtns = isConfirmed
          ? `<button class="btn btn-sm btn-danger mv-reject-btn" data-id="${esc(b.id)}" data-label="Cancel">Cancel</button>`
          : `<button class="btn btn-sm btn-danger mv-reject-btn" data-id="${esc(b.id)}" data-label="${isPending ? 'Reject' : 'Delete'}">${isPending ? 'Reject' : 'Delete'}</button>
             <button class="btn btn-sm btn-primary mv-approve-btn" data-id="${esc(b.id)}" data-label="${isPending ? 'Approve ✓' : 'Confirm ✓'}">${isPending ? 'Approve ✓' : 'Confirm ✓'}</button>`;

        html += `<div class="admin-list-item" style="align-items:flex-start;gap:.75rem">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span style="font-weight:600">${esc(b.label || b.type || 'Booking')}</span>
              ${statusBadge}
            </div>
            <div class="text-muted" style="font-size:.82rem">
              📅 ${b.date ? formatDate(b.date) : '—'}
              ${b.timeSlot ? ` ⏰ ${esc(b.timeSlot)}` : ''}
              🎾 Court ${(typeof b.courtIndex === 'number') ? b.courtIndex + 1 : '—'}
            </div>
            ${b.requestedByName ? `<div class="text-muted" style="font-size:.8rem">Requested by: ${esc(b.requestedByName)}${b.schoolName ? ' · ' + esc(b.schoolName) : ''}</div>` : ''}
            ${b.notes ? `<div class="text-muted" style="font-size:.8rem;font-style:italic">${esc(b.notes)}</div>` : ''}
          </div>
          <div style="display:flex;gap:.4rem;flex-shrink:0;align-items:center">
            ${actionBtns}
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
    // Settings shortcut — navigate to My School and open the settings card
    const settingsShortcut = container.querySelector('#mv-settings-shortcut');
    if (settingsShortcut) {
      settingsShortcut.addEventListener('click', () => {
        if (typeof MySchool !== 'undefined') MySchool.openSettings();
      });
    }
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
        const id      = btn.dataset.id;
        const label   = btn.dataset.label || 'Reject';   // 'Reject', 'Delete', or 'Cancel'
        const booking = DB.getBookings().find(b => b.id === id);
        const wasCancelling = label === 'Cancel';        // previously-confirmed booking
        const confirmMsg = wasCancelling
          ? `Cancel this confirmed booking?\n\n"${booking ? (booking.label || 'Booking') : 'Booking'}" on ${booking && booking.date ? formatDate(booking.date) : '—'}\n\nThis will notify the requester.`
          : `${label} this booking request?`;
        if (!confirm(confirmMsg)) return;
        btn.disabled = true; btn.textContent = wasCancelling ? 'Cancelling…' : 'Rejecting…';
        try {
          await DB.rejectBooking(id);
          DB.writeAudit(wasCancelling ? 'booking_cancelled' : 'booking_rejected', 'booking',
            `${wasCancelling ? 'Cancelled' : 'Rejected'} booking: ${booking ? esc(booking.label || '') : ''} on ${booking ? booking.date : ''}`,
            id, booking ? booking.label || '' : '');
          if (booking && typeof NotificationService !== 'undefined') {
            const notifPayload = {
              type:  wasCancelling ? 'booking_cancelled' : 'booking_rejected',
              title: wasCancelling ? 'Booking Cancelled' : 'Booking Request Rejected',
              body:  wasCancelling
                ? `Your confirmed booking for ${esc(booking.label || venue.name)} on ${booking.date ? formatDate(booking.date) : ''} has been cancelled.`
                : `Your request to book ${esc(booking.label || venue.name)} on ${booking.date ? formatDate(booking.date) : ''} has been declined.`,
            };
            if (booking.requestedBy) {
              // Always notify the original requester, even if they are also the one
              // cancelling (e.g. admin acting in a dual role as school organiser) —
              // they need a record of the cancellation in their notification feed.
              NotificationService.send({ ...notifPayload, recipientUids: [booking.requestedBy] });
            } else if (booking.schoolId) {
              // Legacy booking has no requestedBy (created before that field was added).
              // sendToSchool() calls _ensureUsers() internally so it works even when
              // DB.getUsers() is empty (i.e. users not yet loaded by the admin panel).
              NotificationService.sendToSchool(booking.schoolId, notifPayload);
            }
          }
          toast(wasCancelling ? 'Booking cancelled' : 'Request rejected');
        } catch (err) {
          console.error('Reject/cancel booking failed:', err);
          btn.disabled = false; btn.textContent = label;
          toast('Failed — please try again', 'error');
        }
      });
    });
  }

  return { init, refresh };
})();
