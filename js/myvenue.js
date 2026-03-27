/**
 * myvenue.js — "My Venue" view.
 *
 * Shows every fixture scheduled at the user's managed venue(s) across all
 * leagues, grouped by date.  Overloaded dates (total courtsBooked >
 * venue.courts) are highlighted in red so the organiser can spot
 * scheduling conflicts at a glance and make adjustments.
 *
 * Multi-venue support: a user may manage more than one venue if they are
 * listed as an organiser on multiple schools.  When that is the case a
 * venue-selector bar is shown at the top of the view.
 *
 * Settings are displayed inline (courts + blocked dates) so the user always
 * knows which venue they are editing, regardless of how many venues they
 * manage.  Full school-level settings are still reachable via a link.
 */

const MyVenue = (() => {

  // ── state ────────────────────────────────────────────────────
  let _showUpcomingOnly = false;   // toggle: all | upcoming
  let _activeVenueId    = null;    // null = auto-select first venue
  let _showSettings     = false;   // inline settings panel open?

  // ── helpers ─────────────────────────────────────────────────

  function _normPhone(p) {
    if (!p) return '';
    return p.replace(/\D/g, '').replace(/^0/, '27');
  }

  /**
   * Return all {venue, school|null} pairs this user manages.
   *
   * Three sources, checked in order (each venue appears at most once):
   *  1. profile.schoolId → school.venueId          (primary – always first)
   *  2. school.organizers email/phone match         (secondary school link)
   *  3. venue.contacts email/phone match            (direct venue contact –
   *     school may be null if no school owns the venue)
   */
  function _getMyVenues() {
    if (!Auth.isLoggedIn()) return [];
    const profile = Auth.getProfile();
    if (!profile) return [];

    const email      = (profile.email || '').toLowerCase();
    const phone      = _normPhone(profile.phone);
    const mySchoolId = profile.schoolId;

    const venueMap = new Map(); // venueId → { venue, school|null }

    // ── Pass 1 & 2: via schools ──────────────────────────────────
    DB.getSchools().forEach(school => {
      if (!school.venueId) return;
      if (venueMap.has(school.venueId)) return;

      const venue = DB.getVenues().find(v => v.id === school.venueId);
      if (!venue) return;

      // Primary school
      if (school.id === mySchoolId) {
        venueMap.set(venue.id, { venue, school });
        return;
      }

      // Secondary: user is listed as organiser for this school
      const isOrg = (school.organizers || []).some(org => {
        const orgEmail = (org.email || '').toLowerCase();
        const orgPhone = _normPhone(org.phone);
        return (email && orgEmail && email === orgEmail) ||
               (phone && orgPhone && phone === orgPhone);
      });
      if (isOrg) venueMap.set(venue.id, { venue, school });
    });

    // ── Pass 0: explicitly assigned venue IDs on user profile ───
    // Admin can tick venues directly on a user row in the Admin panel.
    // This is the most direct link and overrides all other discovery.
    (profile.managedVenueIds || []).forEach(venueId => {
      if (venueMap.has(venueId)) return;
      const venue = DB.getVenues().find(v => v.id === venueId);
      if (!venue) return;
      const ownerSchool = DB.getSchools().find(s => s.venueId === venueId) || null;
      venueMap.set(venueId, { venue, school: ownerSchool });
    });

    // ── Pass 3: direct venue contacts ───────────────────────────
    // Catches venues where the user is listed in venue.contacts but is not
    // an organiser on any school that owns that venue.
    DB.getVenues().forEach(venue => {
      if (venueMap.has(venue.id)) return; // already found via school

      const isContact = (venue.contacts || []).some(c => {
        const cEmail = (c.email || '').toLowerCase();
        const cPhone = _normPhone(c.phone);
        return (email && cEmail && email === cEmail) ||
               (phone && cPhone && phone === cPhone);
      });
      if (!isContact) return;

      // Find any school that uses this as its home venue (for the settings link)
      const ownerSchool = DB.getSchools().find(s => s.venueId === venue.id) || null;
      venueMap.set(venue.id, { venue, school: ownerSchool });
    });

    const entries = [...venueMap.values()];

    // Sort: primary school's venue first, then alphabetically
    entries.sort((a, b) => {
      const aPri = a.school && a.school.id === mySchoolId ? 0 : 1;
      const bPri = b.school && b.school.id === mySchoolId ? 0 : 1;
      if (aPri !== bPri) return aPri - bPri;
      return a.venue.name.localeCompare(b.venue.name);
    });
    return entries;
  }

  // ── nav button ───────────────────────────────────────────────
  function _syncNav() {
    const btn = document.querySelector('[data-view="myvenue"]');
    if (!btn) return;
    const hasVenue = Auth.isLoggedIn() && _getMyVenues().length > 0;
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

  // ── inline settings section ──────────────────────────────────
  function _settingsHtml(venue, school) {
    const closures = DB.getClosures()
      .filter(c => c.venueId === venue.id && !c.courtIndex)
      .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

    const closureRows = closures.map(c => `
      <div class="ms-closure-row" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.3rem;flex-wrap:wrap">
        <span style="font-size:.85rem">
          ${formatDate(c.startDate)}${c.endDate && c.endDate !== c.startDate ? ' → ' + formatDate(c.endDate) : ''}
        </span>
        ${c.reason ? `<span class="text-muted" style="font-size:.8rem">${esc(c.reason)}</span>` : ''}
        <button class="btn btn-xs btn-danger mv-closure-del" data-id="${esc(c.id)}" title="Remove">✕</button>
      </div>`).join('') || '<span class="text-muted" style="font-size:.85rem">No blocked dates.</span>';

    return `
      <div class="card" id="mv-settings-card"
           style="margin-bottom:1.5rem;border-left:4px solid var(--primary,#3b82f6)">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <div class="card-title" style="margin:0">⚙️ Settings — ${esc(venue.name)}</div>
          <button class="btn btn-xs btn-secondary" id="mv-settings-close" title="Close settings">✕ Close</button>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:1.25rem">

          <!-- Courts count -->
          <div>
            <label style="font-weight:600;display:block;margin-bottom:.4rem">🎾 Courts available at this venue</label>
            <div style="display:flex;gap:.5rem;align-items:center">
              <input id="mv-courts-input" type="number" min="1" max="30"
                value="${venue.courts || ''}" placeholder="e.g. 4" style="width:80px">
              <button class="btn btn-sm btn-primary" id="mv-courts-save">Save</button>
            </div>
          </div>

          <!-- Blocked dates -->
          <div>
            <label style="font-weight:600;display:block;margin-bottom:.4rem">🚫 Blocked dates (courts unavailable)</label>
            <div id="mv-closures-list" style="margin-bottom:.5rem">${closureRows}</div>
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
              <input type="date" id="mv-block-start" style="flex:1;min-width:130px">
              <span class="text-muted" style="white-space:nowrap">to</span>
              <input type="date" id="mv-block-end" style="flex:1;min-width:130px">
              <input type="text" id="mv-block-reason" placeholder="Reason (optional)"
                style="flex:2;min-width:140px">
              <button class="btn btn-sm btn-secondary" id="mv-block-add">+ Add</button>
            </div>
          </div>

          <!-- Link to full My School settings (only when a school owns this venue) -->
          ${school ? `
          <div style="border-top:1px solid var(--border,#e2e8f0);padding-top:.75rem">
            <button class="btn btn-sm btn-secondary" id="mv-school-settings-link"
              data-school-id="${esc(school.id)}"
              title="Open full school settings in My School">
              🏫 Full school settings →
            </button>
          </div>` : ''}

        </div>
      </div>`;
  }

  // ── main render ──────────────────────────────────────────────
  function _render() {
    const container = document.getElementById('myvenueContent');
    if (!container) return;

    _syncToggleBtns();

    const myVenues = _getMyVenues();

    if (!Auth.isLoggedIn() || myVenues.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🏟</div>
        <p>No venue is linked to your account.<br>
           Ask an admin to assign a home venue to your school.</p>
      </div>`;
      return;
    }

    if (!myVenues.find(e => e.venue.id === _activeVenueId)) {
      _activeVenueId = myVenues[0].venue.id;
    }

    const { venue, school } = myVenues.find(e => e.venue.id === _activeVenueId);

    const title = document.getElementById('myvenueTitle');
    if (title) title.textContent = venue.name;

    const totalCourts = venue.courts || 0;
    const today       = new Date().toISOString().slice(0, 10);

    // ── Venue selector (multi-venue only) ───────────────────────
    let html = '';

    if (myVenues.length > 1) {
      html += `<div class="card" style="margin-bottom:1rem;padding:.75rem 1rem">
        <div style="font-size:.82rem;font-weight:600;color:var(--text-muted,#64748b);margin-bottom:.5rem">
          🏟 Select venue
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">`;
      myVenues.forEach(({ venue: v }) => {
        const active = v.id === _activeVenueId;
        html += `<button class="btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}"
          data-venue-select="${esc(v.id)}">${esc(v.name)}</button>`;
      });
      html += `</div></div>`;
    }

    // ── Venue header ─────────────────────────────────────────────
    html += `<div class="myschool-header" style="justify-content:space-between;align-items:flex-start">
      <div style="display:flex;gap:.75rem;align-items:flex-start">
        <div style="font-size:2rem;line-height:1">🏟</div>
        <div>
          <div class="myschool-school-name">${esc(venue.name)}</div>
          ${venue.address ? `<div class="text-muted">📍 ${esc(venue.address)}</div>` : ''}
          ${totalCourts  ? `<div class="text-muted">🎾 ${totalCourts} court${totalCourts !== 1 ? 's' : ''} available</div>` : ''}
          ${school ? `<div class="text-muted">Home venue for: <strong>${esc(school.name)}</strong></div>` : ''}
        </div>
      </div>
      <button class="btn btn-sm ${_showSettings ? 'btn-primary' : 'btn-secondary'}"
              id="mv-settings-toggle-btn"
              style="flex-shrink:0;white-space:nowrap">
        ⚙️ ${_showSettings ? 'Hide settings' : 'Settings'}
      </button>
    </div>`;

    // ── Inline settings (shown when toggled) ─────────────────────
    if (_showSettings) {
      html += _settingsHtml(venue, school);
    }

    // ── Bookings ──────────────────────────────────────────────────
    const venueBookings = DB.getBookings()
      .filter(b => b.venueId === venue.id && b.status !== 'rejected')
      .slice()
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.timeSlot || '').localeCompare(b.timeSlot || ''));
    const pendingCount = venueBookings.filter(b => b.status !== 'confirmed').length;
    const borderColor  = pendingCount > 0 ? 'var(--warning,#f59e0b)' : 'var(--success,#22c55e)';

    html += `<div class="card" style="margin-bottom:1.5rem;border-left:4px solid ${borderColor}">
      <div class="card-header">
        <div class="card-title" style="margin:0">📩 Venue Bookings
          ${pendingCount > 0
            ? `<span class="badge" style="background:#fef9c3;color:#854d0e;margin-left:.5rem">${pendingCount} awaiting confirmation</span>`
            : `<span class="badge" style="background:#dcfce7;color:#166534;margin-left:.5rem">All confirmed ✓</span>`}
        </div>
      </div>
      <div class="card-body" style="padding:.25rem .75rem .75rem">`;

    if (venueBookings.length === 0) {
      html += `<p class="text-muted" style="padding:.4rem 0;margin:0">No bookings recorded for this venue yet.</p>`;
    } else {
      venueBookings.forEach(b => {
        const isConfirmed = b.status === 'confirmed';
        const isPending   = b.status === 'pending';
        const statusBadge = isConfirmed
          ? `<span class="badge" style="background:#dcfce7;color:#166534;font-size:.7rem">Confirmed ✓</span>`
          : isPending
            ? `<span class="badge" style="background:#fef9c3;color:#854d0e;font-size:.7rem">Request</span>`
            : `<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:.7rem">Admin-scheduled</span>`;
        const actionBtns = isConfirmed
          ? `<button class="btn btn-sm btn-danger mv-reject-btn" data-id="${esc(b.id)}" data-label="Cancel">Cancel</button>`
          : `<button class="btn btn-sm btn-danger mv-reject-btn" data-id="${esc(b.id)}" data-label="${isPending ? 'Reject' : 'Delete'}">${isPending ? 'Reject' : 'Delete'}</button>
             <button class="btn btn-sm btn-primary mv-approve-btn" data-id="${esc(b.id)}">${isPending ? 'Approve ✓' : 'Confirm ✓'}</button>`;

        html += `<div class="admin-list-item" style="align-items:flex-start;gap:.75rem">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span style="font-weight:600">${esc(b.label || b.type || 'Booking')}</span>${statusBadge}
            </div>
            <div class="text-muted" style="font-size:.82rem">
              📅 ${b.date ? formatDate(b.date) : '—'}
              ${b.timeSlot ? ` ⏰ ${esc(b.timeSlot)}` : ''}
              🎾 Court ${(typeof b.courtIndex === 'number') ? b.courtIndex + 1 : '—'}
            </div>
            ${b.requestedByName ? `<div class="text-muted" style="font-size:.8rem">Requested by: ${esc(b.requestedByName)}${b.schoolName ? ' · ' + esc(b.schoolName) : ''}</div>` : ''}
            ${b.notes ? `<div class="text-muted" style="font-size:.8rem;font-style:italic">${esc(b.notes)}</div>` : ''}
          </div>
          <div style="display:flex;gap:.4rem;flex-shrink:0;align-items:center">${actionBtns}</div>
        </div>`;
      });
    }
    html += `</div></div>`;

    // ── Fixtures by date ──────────────────────────────────────────
    const fixturesByDate = new Map();
    DB.getLeagues().forEach(league => {
      (league.fixtures || []).forEach(f => {
        if (f.venueId !== venue.id) return;
        if (_showUpcomingOnly && f.date && f.date < today) return;
        if (!fixturesByDate.has(f.date)) fixturesByDate.set(f.date, []);
        fixturesByDate.get(f.date).push({ fixture: f, league });
      });
    });

    const sortedDates = [...fixturesByDate.keys()].sort();

    if (sortedDates.length === 0) {
      html += `<div class="empty-state" style="margin-top:1rem">
        <div class="empty-icon">📅</div>
        <p>No ${_showUpcomingOnly ? 'upcoming ' : ''}fixtures scheduled at <strong>${esc(venue.name)}</strong>.</p>
      </div>`;
      container.innerHTML = html;
      _wireHandlers(container, venue, school);
      return;
    }

    sortedDates.forEach(date => {
      const entries = fixturesByDate.get(date);
      const booked  = entries.reduce((sum, e) => sum + (e.fixture.courtsBooked || 3), 0);
      const isOver  = totalCourts > 0 && booked > totalCourts;
      const isNear  = totalCourts > 0 && !isOver && booked >= totalCourts;
      const isPast  = date && date < today;

      const statusColor = isOver ? 'var(--danger,#ef4444)' : isNear ? 'var(--warning,#f59e0b)' : 'var(--success,#22c55e)';
      const statusLabel = isOver ? `⚠️ Overbooked — ${booked}/${totalCourts} courts`
                        : isNear ? `⚠️ Full — ${booked}/${totalCourts} courts`
                        : totalCourts ? `✓ ${booked}/${totalCourts} courts`
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

      [...entries]
        .sort((a, b) => (a.fixture.timeSlot || '').localeCompare(b.fixture.timeSlot || '') || a.league.name.localeCompare(b.league.name))
        .forEach(({ fixture: f, league }) => {
          const hasScore   = f.homeScore !== null && f.homeScore !== undefined;
          const courts     = f.courtsBooked || 3;
          const homeSchool = DB.getSchools().find(s => s.id === f.homeSchoolId);
          const awaySchool = DB.getSchools().find(s => s.id === f.awaySchoolId);

          html += `<div class="myschool-fixture" style="margin:.5rem 0;background:var(--surface2,#f8fafc);border-radius:6px;padding:.5rem .75rem">
            <div class="fixture-meta" style="margin-bottom:.2rem">
              <span class="text-muted" style="font-size:.78rem">🏆 ${esc(league.name)}${league.division ? ' · ' + esc(league.division) : ''}</span>
              ${f.timeSlot ? `<span class="text-muted" style="font-size:.78rem">⏰ ${esc(f.timeSlot)}</span>` : ''}
              <span class="text-muted" style="font-size:.78rem">🎾 ${courts === 1 ? '1 court' : courts + ' courts'}</span>
            </div>
            <div class="fixture-score-row">
              <span class="fixture-team">
                <span style="color:${homeSchool ? homeSchool.color : '#666'}">●</span> ${esc(f.homeSchoolName)}
              </span>
              <span class="fixture-score">
                ${hasScore ? `<strong>${f.homeScore} — ${f.awayScore}</strong>` : '<span class="text-muted">vs</span>'}
              </span>
              <span class="fixture-team">
                <span style="color:${awaySchool ? awaySchool.color : '#666'}">●</span> ${esc(f.awaySchoolName)}
              </span>
            </div>
          </div>`;
        });

      html += `</div></div>`;
    });

    container.innerHTML = html;
    _wireHandlers(container, venue, school);
  }

  // ── Wire all interactive handlers ────────────────────────────
  function _wireHandlers(container, venue, school) {

    // ── Venue selector ──────────────────────────────────────────
    container.querySelectorAll('[data-venue-select]').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeVenueId = btn.dataset.venueSelect;
        _render();
      });
    });

    // ── Settings toggle ─────────────────────────────────────────
    container.querySelector('#mv-settings-toggle-btn')?.addEventListener('click', () => {
      _showSettings = !_showSettings;
      _render();
    });

    // ── Settings: close button ──────────────────────────────────
    container.querySelector('#mv-settings-close')?.addEventListener('click', () => {
      _showSettings = false;
      _render();
    });

    // ── Settings: save courts ───────────────────────────────────
    container.querySelector('#mv-courts-save')?.addEventListener('click', () => {
      const n = parseInt(document.getElementById('mv-courts-input').value, 10);
      if (isNaN(n) || n < 1 || n > 30) {
        toast('Enter a number between 1 and 30', 'error');
        return;
      }
      DB.updateVenue({ ...venue, courts: n })
        .then(() => { toast(`Courts saved — ${n} court${n !== 1 ? 's' : ''} ✓`, 'success'); _render(); })
        .catch(err => toast('Save failed — ' + err.message, 'error'));
    });

    // ── Settings: add blocked date ──────────────────────────────
    container.querySelector('#mv-block-add')?.addEventListener('click', () => {
      const start  = document.getElementById('mv-block-start').value;
      const end    = document.getElementById('mv-block-end').value || start;
      const reason = document.getElementById('mv-block-reason').value.trim();
      if (!start) { toast('Select a start date', 'error'); return; }
      if (end < start) { toast('End date must be on or after start date', 'error'); return; }
      DB.addClosure({ venueId: venue.id, startDate: start, endDate: end, reason });
      toast('Blocked date added ✓', 'success');
      _render();
    });

    // ── Settings: delete blocked date ───────────────────────────
    container.querySelectorAll('.mv-closure-del').forEach(btn => {
      btn.addEventListener('click', () => {
        DB.deleteClosure(btn.dataset.id)
          .then(() => { toast('Blocked date removed', 'success'); _render(); })
          .catch(err => { toast('Failed — ' + err.message, 'error'); });
      });
    });

    // ── Settings: link to full school settings ──────────────────
    container.querySelector('#mv-school-settings-link')?.addEventListener('click', function () {
      if (typeof MySchool === 'undefined') return;
      const linkSchoolId  = this.dataset.schoolId;
      const activeSchool  = MySchool.getActiveSchoolId();
      if (linkSchoolId && linkSchoolId !== activeSchool) {
        MySchool.impersonate(linkSchoolId);
      }
      MySchool.openSettings();
    });

    // ── Booking: approve ────────────────────────────────────────
    container.querySelectorAll('.mv-approve-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id      = btn.dataset.id;
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

    // ── Booking: reject / cancel ────────────────────────────────
    container.querySelectorAll('.mv-reject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id            = btn.dataset.id;
        const label         = btn.dataset.label || 'Reject';
        const booking       = DB.getBookings().find(b => b.id === id);
        const wasCancelling = label === 'Cancel';
        const confirmMsg    = wasCancelling
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
              NotificationService.send({ ...notifPayload, recipientUids: [booking.requestedBy] });
            } else if (booking.schoolId) {
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
