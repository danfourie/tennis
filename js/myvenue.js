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
  let _viewMode      = 'upcoming'; // 'upcoming' | 'all' | 'history'
  let _activeVenueId = null;       // null = auto-select first venue
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
    ['mvViewUpcoming', 'mvViewAll', 'mvViewHistory'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const mode = id === 'mvViewUpcoming' ? 'upcoming' : id === 'mvViewAll' ? 'all' : 'history';
      btn.className = `btn btn-sm ${_viewMode === mode ? 'btn-primary' : 'btn-secondary'}`;
    });
  }

  // ── public API ───────────────────────────────────────────────
  function init() {
    [['mvViewUpcoming', 'upcoming'], ['mvViewAll', 'all'], ['mvViewHistory', 'history']].forEach(([id, mode]) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => { _viewMode = mode; _syncToggleBtns(); _render(); });
    });
  }

  function refresh() {
    _syncNav();
    const view = document.getElementById('view-myvenue');
    if (view && !view.classList.contains('hidden')) _render();
  }

  // ── inline settings section ──────────────────────────────────
  function _settingsHtml(venue, school) {
    const isRestricted = !!venue.restrictedMode;
    const closures = DB.getClosures()
      .filter(c => c.venueId === venue.id && !c.courtIndex &&
        (isRestricted ? c.type === 'open' : (!c.type || c.type === 'block')))
      .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

    const emptyMsg = isRestricted
      ? 'No open windows added yet — all dates are blocked.'
      : 'No blocked dates.';

    const closureRows = closures.map(c => `
      <div class="ms-closure-row" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.3rem;flex-wrap:wrap">
        <span style="font-size:.85rem">
          ${formatDate(c.startDate)}${c.endDate && c.endDate !== c.startDate ? ' → ' + formatDate(c.endDate) : ''}
          ${c.timeStart && c.timeEnd ? ` <span class="text-muted">⏰ ${esc(c.timeStart)}–${esc(c.timeEnd)}</span>` : ''}
        </span>
        ${c.reason ? `<span class="text-muted" style="font-size:.8rem">${esc(c.reason)}</span>` : ''}
        <button class="btn btn-xs btn-danger mv-closure-del" data-id="${esc(c.id)}" title="Remove">✕</button>
      </div>`).join('') || `<span class="text-muted" style="font-size:.85rem">${emptyMsg}</span>`;

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

          <!-- Restricted mode toggle -->
          <div>
            <label style="font-weight:600;display:block;margin-bottom:.5rem">📅 Availability mode</label>
            <div style="display:flex;align-items:center;gap:.75rem">
              <label class="toggle-switch" style="margin:0">
                <input type="checkbox" id="mv-restricted-toggle" ${isRestricted ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
              <div>
                <span style="font-weight:500">Restricted mode</span>
                <div class="text-muted" style="font-size:.78rem">
                  ${isRestricted
                    ? 'All dates blocked — only listed open windows are bookable'
                    : 'All dates open — only blocked dates are unavailable'}
                </div>
              </div>
            </div>
          </div>

          <!-- Blocked dates / Open windows -->
          <div>
            <label style="font-weight:600;display:block;margin-bottom:.4rem">
              ${isRestricted ? '✅ Open windows' : '🚫 Blocked dates (courts unavailable)'}
            </label>
            <div id="mv-closures-list" style="margin-bottom:.5rem">${closureRows}</div>
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
              <input type="date" id="mv-block-start" style="flex:1;min-width:130px">
              <span class="text-muted" style="white-space:nowrap">to</span>
              <input type="date" id="mv-block-end" style="flex:1;min-width:130px">
              ${isRestricted ? `
              <input type="time" id="mv-block-time-start" style="flex:1;min-width:110px" placeholder="From time">
              <span class="text-muted" style="white-space:nowrap">–</span>
              <input type="time" id="mv-block-time-end" style="flex:1;min-width:110px" placeholder="To time">
              ` : ''}
              <input type="text" id="mv-block-reason" placeholder="${isRestricted ? 'Label (optional)' : 'Reason (optional)'}"
                style="flex:2;min-width:140px">
              <button class="btn btn-sm btn-secondary" id="mv-block-add">+ ${isRestricted ? 'Add window' : 'Add'}</button>
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
    const allVenueBookings = DB.getBookings()
      .filter(b => b.venueId === venue.id)
      .slice()
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.timeSlot || '').localeCompare(b.timeSlot || ''));

    // Bookings split by view mode
    const activeBookings  = allVenueBookings.filter(b =>
      b.date >= today && (b.status === 'pending' || b.status === 'confirmed')
    );
    const historyBookings = allVenueBookings
      .filter(b => b.date < today || b.status === 'cancelled' || b.status === 'rejected')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const shownBookings  = _viewMode === 'history'  ? historyBookings
                         : _viewMode === 'upcoming' ? activeBookings
                         : allVenueBookings; // 'all'

    // Helper: render a list of bookings into html (active or history)
    function _renderBookingRows(list) {
      let out = '';
      const groups = [];
      const seenGroups = {};
      list.forEach(b => {
        const key = b.groupId || ('__' + b.id);
        if (!seenGroups[key]) { seenGroups[key] = { groupId: b.groupId || null, bookings: [] }; groups.push(seenGroups[key]); }
        seenGroups[key].bookings.push(b);
      });

      groups.forEach(group => {
        const isMulti      = !!(group.groupId && group.bookings.length > 1);
        const anyPending   = group.bookings.some(b => b.status === 'pending');
        const anyConfirmed = group.bookings.some(b => b.status === 'confirmed');

        if (isMulti) {
          const requester = group.bookings[0].requestedByName || 'User';
          const label     = group.bookings[0].label || group.bookings[0].type || 'Booking';
          out += `<div class="cb-group-block">
            <div class="cb-group-header">
              <span><strong>📦 ${esc(requester)}</strong> — ${group.bookings.length} slots · ${esc(label)}</span>
              ${(anyPending || anyConfirmed) ? `<div style="display:flex;gap:.4rem">
                ${(anyPending || anyConfirmed) ? `<button class="btn btn-sm btn-danger mv-cancel-group-btn" data-group-id="${esc(group.groupId)}">Cancel All</button>` : ''}
                ${anyPending ? `<button class="btn btn-sm btn-danger mv-reject-group-btn" data-group-id="${esc(group.groupId)}">Reject All</button>` : ''}
                ${anyPending ? `<button class="btn btn-sm btn-primary mv-approve-group-btn" data-group-id="${esc(group.groupId)}">Approve All</button>` : ''}
              </div>` : ''}
            </div>`;
        }

        group.bookings.forEach(b => {
          const isConfirmed = b.status === 'confirmed';
          const isPending   = b.status === 'pending';
          const isRejected  = b.status === 'rejected';
          const isCancelled = b.status === 'cancelled';
          const statusBadge = isConfirmed
            ? `<span class="badge" style="background:#dcfce7;color:#166534;font-size:.7rem">Confirmed ✓</span>`
            : isPending
              ? `<span class="badge" style="background:#fef9c3;color:#854d0e;font-size:.7rem">Request</span>`
              : isRejected
                ? `<span class="badge" style="background:#fee2e2;color:#991b1b;font-size:.7rem">Rejected ✗</span>`
                : isCancelled
                  ? `<span class="badge" style="background:#f3f4f6;color:#6b7280;font-size:.7rem">Cancelled</span>`
                  : `<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:.7rem">Admin-scheduled</span>`;
          const actionBtns = (isRejected || isCancelled) ? '' :
            isConfirmed
              ? `<button class="btn btn-sm btn-danger mv-reject-btn" data-id="${esc(b.id)}" data-label="Cancel">Cancel</button>`
              : `<button class="btn btn-sm btn-danger mv-reject-btn" data-id="${esc(b.id)}" data-label="${isPending ? 'Reject' : 'Delete'}">${isPending ? 'Reject' : 'Delete'}</button>
                 <button class="btn btn-sm btn-primary mv-approve-btn" data-id="${esc(b.id)}">${isPending ? 'Approve ✓' : 'Confirm ✓'}</button>`;

          out += `<div class="admin-list-item${isMulti ? ' group-slot-item' : ''}" style="align-items:flex-start;gap:.75rem">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
                <span style="font-weight:600">${esc(b.label || b.type || 'Booking')}</span>${statusBadge}
              </div>
              <div class="text-muted" style="font-size:.82rem">
                📅 ${b.date ? formatDate(b.date) : '—'}
                ${b.timeSlot ? ` ⏰ ${esc(b.timeSlot)}` : ''}
                🎾 Court ${(typeof b.courtIndex === 'number') ? b.courtIndex + 1 : '—'}
              </div>
              ${!isMulti && b.requestedByName ? `<div class="text-muted" style="font-size:.8rem">Requested by: ${esc(b.requestedByName)}${b.schoolName ? ' · ' + esc(b.schoolName) : ''}</div>` : ''}
              ${b.notes ? `<div class="text-muted" style="font-size:.8rem;font-style:italic">${esc(b.notes)}</div>` : ''}
            </div>
            <div style="display:flex;gap:.4rem;flex-shrink:0;align-items:center">${actionBtns}</div>
          </div>`;
        });

        if (isMulti) out += `</div>`;
      });
      return out;
    }

    // Bookings card — show only what the current view mode calls for
    const pendingCountDisplay = activeBookings.filter(b => b.status === 'pending').length;
    const borderColorDisplay  = pendingCountDisplay > 0 ? 'var(--warning,#f59e0b)' : 'var(--success,#22c55e)';

    html += `<div class="card" style="margin-bottom:1.5rem;border-left:4px solid ${borderColorDisplay}">
      <div class="card-header">
        <div class="card-title" style="margin:0">📩 Venue Bookings
          ${pendingCountDisplay > 0
            ? `<span class="badge" style="background:#fef9c3;color:#854d0e;margin-left:.5rem">${pendingCountDisplay} awaiting confirmation</span>`
            : `<span class="badge" style="background:#dcfce7;color:#166534;margin-left:.5rem">All confirmed ✓</span>`}
        </div>
      </div>
      <div class="card-body" style="padding:.25rem .75rem .75rem">`;

    if (shownBookings.length === 0) {
      const emptyMsg = _viewMode === 'history'  ? 'No past or cancelled bookings.'
                     : _viewMode === 'upcoming' ? 'No upcoming bookings for this venue.'
                     : 'No bookings recorded for this venue yet.';
      html += `<p class="text-muted" style="padding:.4rem 0;margin:0">${emptyMsg}</p>`;
    } else {
      html += _renderBookingRows(shownBookings);
    }

    html += `</div></div>`;

    // ── Fixtures by date ──────────────────────────────────────────
    const allFixturesByDate = new Map();
    DB.getLeagues().forEach(league => {
      (league.fixtures || []).forEach(f => {
        if (f.venueId !== venue.id) return;
        if (!allFixturesByDate.has(f.date)) allFixturesByDate.set(f.date, []);
        allFixturesByDate.get(f.date).push({ fixture: f, league });
      });
    });

    // Split fixture dates by past / upcoming, then filter by view mode
    const allFixtureDates     = [...allFixturesByDate.keys()].sort();
    const upcomingFixtureDates = allFixtureDates.filter(d => d >= today);
    const pastFixtureDates     = allFixtureDates.filter(d => d < today).reverse(); // newest-past first

    const shownFixtureDates = _viewMode === 'history'  ? pastFixtureDates
                            : _viewMode === 'upcoming' ? upcomingFixtureDates
                            : allFixtureDates; // 'all' = upcoming order, past appended

    if (shownFixtureDates.length === 0) {
      const fixtureEmpty = _viewMode === 'history'  ? 'No past fixtures at this venue.'
                         : _viewMode === 'upcoming' ? 'No upcoming fixtures scheduled at'
                         : 'No fixtures scheduled at';
      html += `<div class="empty-state" style="margin-top:1rem">
        <div class="empty-icon">📅</div>
        <p>${fixtureEmpty} <strong>${esc(venue.name)}</strong>.</p>
      </div>`;
      container.innerHTML = html;
      _wireHandlers(container, venue, school);
      return;
    }

    function _renderFixtureDateCard(date) {
      const entries = allFixturesByDate.get(date);
      const booked  = entries.reduce((sum, e) => sum + (e.fixture.courtsBooked || 3), 0);
      const isOver  = totalCourts > 0 && booked > totalCourts;
      const isNear  = totalCourts > 0 && !isOver && booked >= totalCourts;
      const isPast  = date && date < today;

      const statusColor = isOver ? 'var(--danger,#ef4444)' : isNear ? 'var(--warning,#f59e0b)' : 'var(--success,#22c55e)';
      const statusLabel = isOver ? `⚠️ Overbooked — ${booked}/${totalCourts} courts`
                        : isNear ? `⚠️ Full — ${booked}/${totalCourts} courts`
                        : totalCourts ? `✓ ${booked}/${totalCourts} courts`
                        : `${booked} courts booked`;

      let out = `<div class="card" style="margin-bottom:1rem;border-left:4px solid ${statusColor}${isPast ? ';opacity:.8' : ''}">
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

          out += `<div class="myschool-fixture" style="margin:.5rem 0;background:var(--surface2,#f8fafc);border-radius:6px;padding:.5rem .75rem">
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

      return out + `</div></div>`;
    }

    // In 'all' mode render upcoming first, then past; other modes just render shownFixtureDates
    if (_viewMode === 'all') {
      upcomingFixtureDates.forEach(d => { html += _renderFixtureDateCard(d); });
      if (pastFixtureDates.length > 0) {
        html += `<details style="margin-top:.5rem">
          <summary style="font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--neutral);cursor:pointer;user-select:none;padding:.25rem 0">
            Past fixtures (${pastFixtureDates.length} date${pastFixtureDates.length !== 1 ? 's' : ''})
          </summary>
          <div style="margin-top:.5rem">${pastFixtureDates.map(_renderFixtureDateCard).join('')}</div>
        </details>`;
      }
    } else {
      shownFixtureDates.forEach(d => { html += _renderFixtureDateCard(d); });
    }

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

    // ── Settings: restricted mode toggle ───────────────────────
    container.querySelector('#mv-restricted-toggle')?.addEventListener('change', function () {
      const updated = { ...venue, restrictedMode: this.checked };
      DB.updateVenue(updated)
        .then(() => {
          toast(this.checked ? 'Restricted mode on — only open windows are bookable' : 'Normal mode — all dates open by default', 'success');
          if (typeof Calendar !== 'undefined') Calendar.refresh();
          _render();
        })
        .catch(err => { toast('Save failed — ' + err.message, 'error'); this.checked = !this.checked; });
    });

    // ── Settings: add blocked date / open window ────────────────
    container.querySelector('#mv-block-add')?.addEventListener('click', () => {
      const isRestricted = !!venue.restrictedMode;
      const start      = document.getElementById('mv-block-start').value;
      const end        = document.getElementById('mv-block-end').value || start;
      const reason     = document.getElementById('mv-block-reason').value.trim();
      const timeStart  = isRestricted ? (document.getElementById('mv-block-time-start')?.value || '') : '';
      const timeEnd    = isRestricted ? (document.getElementById('mv-block-time-end')?.value || '') : '';
      if (!start) { toast('Select a start date', 'error'); return; }
      if (end < start) { toast('End date must be on or after start date', 'error'); return; }
      if (isRestricted && (!timeStart || !timeEnd)) { toast('Enter a time range for the open window', 'error'); return; }
      if (isRestricted && timeEnd <= timeStart) { toast('End time must be after start time', 'error'); return; }
      const closure = { venueId: venue.id, startDate: start, endDate: end, reason, type: isRestricted ? 'open' : 'block' };
      if (timeStart) closure.timeStart = timeStart;
      if (timeEnd)   closure.timeEnd   = timeEnd;
      DB.addClosure(closure);
      toast(isRestricted ? 'Open window added ✓' : 'Blocked date added ✓', 'success');
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

    // ── Booking: approve entire group ───────────────────────────
    container.querySelectorAll('.mv-approve-group-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const groupId      = btn.dataset.groupId;
        const groupPending = DB.getBookings().filter(b => b.groupId === groupId && b.venueId === venue.id && b.status === 'pending');
        if (groupPending.length === 0) return;
        btn.disabled = true; btn.textContent = 'Approving…';
        for (const b of groupPending) { DB.approveBooking(b.id); }
        DB.writeAudit('booking_approved', 'booking',
          `Approved group booking (${groupPending.length} slots) at ${venue.name}`, null, groupPending[0]?.label || '');
        const first = groupPending[0];
        if (first && first.requestedBy && typeof NotificationService !== 'undefined') {
          NotificationService.send({
            type:          'booking_approved',
            title:         'Booking Request Approved ✅',
            body:          `Your ${groupPending.length}-slot booking request at ${esc(venue.name)} has been approved.`,
            recipientUids: [first.requestedBy],
          });
        }
        if (first) {
          try { await firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: first.id, action: 'approved' }); } catch (e) { /* non-critical */ }
        }
        toast(`${groupPending.length} bookings approved ✓`, 'success');
      });
    });

    // ── Booking: reject entire group ─────────────────────────────
    container.querySelectorAll('.mv-reject-group-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const groupId      = btn.dataset.groupId;
        const groupPending = DB.getBookings().filter(b => b.groupId === groupId && b.venueId === venue.id && b.status === 'pending');
        if (groupPending.length === 0) return;
        if (!bookingCancellationAllowed(groupPending[0])) {
          toast('Cancellations are not permitted within 4 hours of the booking time or after the event has taken place.', 'error');
          return;
        }
        if (!confirm(`Reject all ${groupPending.length} slots in this group request?`)) return;
        btn.disabled = true; btn.textContent = 'Rejecting…';
        const first = groupPending[0];
        // Email before deleting (booking docs must still exist for the CF to read)
        if (first) {
          try { await firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: first.id, action: 'rejected' }); } catch (e) { /* non-critical */ }
        }
        if (first && first.requestedBy && typeof NotificationService !== 'undefined') {
          NotificationService.send({
            type:          'booking_rejected',
            title:         'Booking Request Rejected',
            body:          `Your ${groupPending.length}-slot booking request at ${esc(venue.name)} has been declined.`,
            recipientUids: [first.requestedBy],
          });
        }
        try {
          for (const b of groupPending) { await DB.rejectBooking(b.id, 'rejected'); }
        } catch (e) { /* best-effort */ }
        DB.writeAudit('booking_rejected', 'booking',
          `Rejected group booking (${groupPending.length} slots) at ${venue.name}`, null, '');
        toast(`${groupPending.length} booking requests rejected`, 'success');
      });
    });

    // ── Booking: cancel entire group (pending + confirmed) ──────────
    container.querySelectorAll('.mv-cancel-group-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const groupId      = btn.dataset.groupId;
        const groupActive  = DB.getBookings().filter(b => b.groupId === groupId && b.venueId === venue.id && ['pending', 'confirmed'].includes(b.status));
        if (groupActive.length === 0) return;
        if (!bookingCancellationAllowed(groupActive[0])) {
          toast('Cancellations are not permitted within 4 hours of the booking time or after the event has taken place.', 'error');
          return;
        }
        if (!confirm(`Cancel all ${groupActive.length} slot(s) in this group booking?`)) return;
        btn.disabled = true; btn.textContent = 'Cancelling…';
        const first = groupActive[0];
        if (first) {
          try { await firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: first.id, action: 'cancelled' }); } catch (e) { /* non-critical */ }
        }
        if (first && first.requestedBy && typeof NotificationService !== 'undefined') {
          NotificationService.send({
            type:          'booking_cancelled',
            title:         'Booking Cancelled',
            body:          `Your ${groupActive.length}-slot booking at ${esc(venue.name)} has been cancelled.`,
            recipientUids: [first.requestedBy],
          });
        }
        try {
          for (const b of groupActive) { await DB.rejectBooking(b.id, 'cancelled'); }
        } catch (e) { /* best-effort */ }
        DB.writeAudit('booking_cancelled', 'booking',
          `Cancelled group booking (${groupActive.length} slots) at ${venue.name}`, null, '');
        toast(`${groupActive.length} booking(s) cancelled`, 'success');
      });
    });

    // ── Booking: approve ────────────────────────────────────────
    container.querySelectorAll('.mv-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
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
        // Email the requester
        try { await firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: id, action: 'approved' }); } catch (e) { /* non-critical */ }
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
        if (!bookingCancellationAllowed(booking)) {
          toast('Cancellations are not permitted within 4 hours of the booking time or after the event has taken place.', 'error');
          return;
        }
        const confirmMsg    = wasCancelling
          ? `Cancel this confirmed booking?\n\n"${booking ? (booking.label || 'Booking') : 'Booking'}" on ${booking && booking.date ? formatDate(booking.date) : '—'}\n\nThis will notify the requester.`
          : `${label} this booking request?`;
        if (!confirm(confirmMsg)) return;
        btn.disabled = true; btn.textContent = wasCancelling ? 'Cancelling…' : 'Rejecting…';
        try {
          try {
            await firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: id, action: wasCancelling ? 'cancelled' : 'rejected' });
          } catch (e) { /* non-critical */ }
          await DB.rejectBooking(id, wasCancelling ? 'cancelled' : 'rejected');
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
