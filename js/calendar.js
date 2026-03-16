/**
 * calendar.js — Weekly court availability calendar
 *
 * Role-aware behaviour:
 *   Master / Admin      → direct booking (confirmed) at any venue
 *   Venue Organiser     → direct booking at their own venue; can also
 *                         approve/reject pending requests there
 *   Logged-in user      → request booking at any venue (pending approval)
 *                         owner can cancel their own pending request
 *   Visitor             → view-only
 *
 * League blocking:
 *   Fixtures stored in leagues collection automatically block their court
 *   for 3 hours from the fixture matchTime.  These slots appear as league
 *   chips and cannot be booked/requested.
 */

const Calendar = (() => {
  let currentWeekStart   = weekStart(new Date());
  let currentVenueFilter = 'all';

  // ── Time helper ─────────────────────────────────────────────
  function _timeToMins(t) {
    const [h, m] = (t || '00:00').split(':').map(Number);
    return h * 60 + m;
  }

  /**
   * Is the logged-in user the organiser of this venue?
   * (Their school's home venue = this venue.)
   */
  function _isVenueOrganizer(venueId) {
    if (!Auth.isLoggedIn()) return false;
    const profile = Auth.getProfile();
    if (!profile || !profile.schoolId) return false;
    const school = DB.getSchools().find(s => s.id === profile.schoolId);
    return !!(school && school.venueId === venueId);
  }

  /** True when the user may book directly / approve-reject at this venue. */
  function _canManageVenue(venueId) {
    return Auth.isAdmin() || _isVenueOrganizer(venueId);
  }

  /**
   * Return { fixture, league } if a league fixture occupies this slot.
   * A match blocks its court for MATCH_MINS (3 hours) from matchTime.
   */
  function _getLeagueFixtureForSlot(venueId, courtIndex, dateStr, timeStr) {
    const slotMins   = _timeToMins(timeStr);
    const MATCH_MINS = 180; // 3 hours

    for (const league of DB.getLeagues()) {
      for (const f of (league.fixtures || [])) {
        if (!f.venueId || f.venueId !== venueId) continue;
        if (f.date !== dateStr) continue;
        // court can be specific or "any court" (null/empty)
        const fCourt = (f.courtIndex !== null && f.courtIndex !== undefined && f.courtIndex !== '')
          ? parseInt(f.courtIndex) : null;
        if (fCourt !== null && fCourt !== courtIndex) continue;
        const fixtureMins = _timeToMins(f.timeSlot || '14:00');
        if (slotMins >= fixtureMins && slotMins < fixtureMins + MATCH_MINS) {
          return { fixture: f, league };
        }
      }
    }
    return null;
  }

  // ── Init ────────────────────────────────────────────────────
  function init() {
    document.getElementById('prevWeek').addEventListener('click', () => {
      currentWeekStart = addDays(currentWeekStart, -7);
      render();
    });
    document.getElementById('nextWeek').addEventListener('click', () => {
      currentWeekStart = addDays(currentWeekStart, 7);
      render();
    });
    document.getElementById('todayBtn').addEventListener('click', () => {
      currentWeekStart = weekStart(new Date());
      render();
    });
    document.getElementById('venueFilter').addEventListener('change', e => {
      currentVenueFilter = e.target.value;
      render();
    });
    populateVenueFilter();
    render();
  }

  function populateVenueFilter() {
    const sel    = document.getElementById('venueFilter');
    const venues = [...DB.getVenues()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    while (sel.options.length > 1) sel.remove(1);
    venues.forEach(v => sel.add(new Option(v.name, v.id)));
  }

  function refresh() {
    populateVenueFilter();
    render();
  }

  // ── Main render ─────────────────────────────────────────────
  function render() {
    const container     = document.getElementById('calendarContainer');
    const allVenues     = [...DB.getVenues()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const filteredVenues = currentVenueFilter === 'all'
      ? allVenues
      : allVenues.filter(v => v.id === currentVenueFilter);

    const days     = Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i));
    const todayStr = toDateStr(new Date());

    document.getElementById('weekLabel').textContent =
      `${formatDateShort(days[0])} – ${formatDateShort(days[6])} ${days[0].getFullYear()}`;

    if (filteredVenues.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎾</div><p>No venues configured. Add one in Admin.</p></div>`;
      return;
    }

    const slots    = getTimeSlots();
    const settings = DB.getSettings();

    let html = `<div class="calendar-grid">`;

    // Header row
    html += `<div class="cal-header-row"><div class="cal-header-time">Court</div>`;
    days.forEach((d, i) => {
      const dStr    = toDateStr(d);
      const isToday = dStr === todayStr;
      html += `<div class="cal-header-day${isToday ? ' today' : ''}">
        <div class="cal-day-name">${DAY_NAMES[i]}</div>
        <div class="cal-day-num">${d.getDate()}</div>
      </div>`;
    });
    html += `</div>`;

    // Venue sections — alphabetical
    filteredVenues.forEach(venue => {
      const courtCount = venue.courts || 4;
      html += `<div class="cal-venue-section">`;
      html += `<div class="cal-venue-header"><div class="cal-venue-label">📍 ${esc(venue.name)}</div></div>`;

      for (let ci = 0; ci < courtCount; ci++) {
        html += `<div class="cal-court-row">`;
        html += `<div class="cal-court-label">Court ${ci + 1}</div>`;

        days.forEach(d => {
          const dStr        = toDateStr(d);
          const isToday     = dStr === todayStr;
          const courtClosed = isCourtClosed(venue.id, ci, dStr, null);
          html += `<div class="cal-day-cell${isToday ? ' today' : ''}${courtClosed ? ' closed' : ''}">`;

          if (courtClosed && !_hasTimeSpecificClosure(venue.id, ci, dStr)) {
            html += `<span class="slot-chip closed" title="Court unavailable">Closed</span>`;
          } else {
            slots.forEach(slot => {
              html += _renderSlot(venue, ci, dStr, slot, courtClosed, settings.slotDuration);
            });
          }
          html += `</div>`;
        });
        html += `</div>`; // end court row
      }
      html += `</div>`; // end venue section
    });

    // Legend
    html += `<div class="cal-legend">
      <div class="legend-item"><div class="legend-dot" style="background:#dcfce7;border:1px solid #86efac"></div> Available</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fef3c7;border:1px solid #fcd34d"></div> Booked</div>
      <div class="legend-item"><div class="legend-dot" style="background:#ede9fe;border:1px solid #c4b5fd"></div> League</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fce7f3;border:1px solid #f9a8d4"></div> Tournament</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fff7ed;border:1px dashed #f97316"></div> Pending</div>
      <div class="legend-item"><div class="legend-dot" style="background:#f3f4f6;border:1px solid #d1d5db"></div> Closed</div>
    </div>`;

    html += `</div>`; // end grid
    container.innerHTML = html;

    // Click handlers
    container.querySelectorAll('[data-slot]').forEach(el => {
      el.addEventListener('click', () => {
        const { venue: vId, court, date, slotTime: slot } = el.dataset;
        openSlotModal(vId, parseInt(court), date, slot);
      });
    });
  }

  // ── Slot chip renderer ─────────────────────────────────────
  function _hasTimeSpecificClosure(venueId, courtIndex, dateStr) {
    return DB.getClosures().some(c => {
      if (c.venueId !== venueId) return false;
      if (c.courtIndex !== null && c.courtIndex !== undefined && c.courtIndex !== '' && c.courtIndex != courtIndex) return false;
      if (dateStr < c.startDate || dateStr > c.endDate) return false;
      return !!(c.timeStart && c.timeEnd);
    });
  }

  function _renderSlot(venue, ci, dStr, slot, courtFullyClosed, durationMins) {
    if (courtFullyClosed && !_hasTimeSpecificClosure(venue.id, ci, dStr)) return '';

    const slotClosed = isCourtClosed(venue.id, ci, dStr, slot);
    if (slotClosed) {
      return `<span class="slot-chip closed" title="Closed">${slot}</span>`;
    }

    // ── Existing booking (from bookings collection) ──────────
    const booking = getSlotBooking(venue.id, ci, dStr, slot);
    if (booking) {
      const isPending = booking.status === 'pending';
      const type      = booking.type || 'booking';
      const cls       = isPending        ? 'pending-request'
        : type === 'league'     ? 'league'
        : type === 'tournament' ? 'tournament'
        : 'booked';
      const rawLabel  = booking.label || booking.schoolName || (isPending ? 'Pending' : 'Booked');
      const label     = esc(rawLabel);
      const badge     = isPending ? ' ⏳' : '';
      return `<button class="slot-chip ${cls}" data-slot="1" data-venue="${venue.id}" data-court="${ci}" data-date="${dStr}" data-slot-time="${slot}" title="${label}${badge} @ ${slot}">${label}${badge}<span class="slot-time">${slot}</span></button>`;
    }

    // ── League fixture blocking (3-hour window) ──────────────
    const leagueSlot = _getLeagueFixtureForSlot(venue.id, ci, dStr, slot);
    if (leagueSlot) {
      const { fixture: f, league } = leagueSlot;
      const isStart = _timeToMins(slot) === _timeToMins(f.timeSlot || '14:00');
      const label   = `${f.homeSchoolName} vs ${f.awaySchoolName}`;
      // First slot: show team names; continuation slots: show arrow + abbreviated label
      const display = isStart
        ? esc(label)
        : `↳ ${esc(f.homeSchoolName)} vs ${esc(f.awaySchoolName)}`;
      return `<span class="slot-chip league league-fixture" title="${esc(label)} @ ${f.timeSlot || '14:00'} — ${esc(league.name)}">${display}<span class="slot-time">${slot}</span></span>`;
    }

    // ── Available ────────────────────────────────────────────
    const canBookDirect = _canManageVenue(venue.id);
    if (canBookDirect) {
      return `<button class="slot-chip available admin-can-book" data-slot="1" data-venue="${venue.id}" data-court="${ci}" data-date="${dStr}" data-slot-time="${slot}" title="Book this slot">${slot}</button>`;
    }
    if (Auth.isLoggedIn()) {
      return `<button class="slot-chip available user-can-request" data-slot="1" data-venue="${venue.id}" data-court="${ci}" data-date="${dStr}" data-slot-time="${slot}" title="Request this slot">${slot}</button>`;
    }
    return `<span class="slot-chip available" title="Available">${slot}</span>`;
  }

  // ── Slot modal ─────────────────────────────────────────────
  function openSlotModal(venueId, courtIndex, dateStr, timeStr) {
    const venue = DB.getVenues().find(v => v.id === venueId);
    if (!venue) return;

    const booking     = getSlotBooking(venueId, courtIndex, dateStr, timeStr);
    const title       = document.getElementById('bookingModalTitle');
    const body        = document.getElementById('bookingModalBody');
    const footer      = document.getElementById('bookingModalFooter');
    const canManage   = _canManageVenue(venueId);
    const isOrganizer = _isVenueOrganizer(venueId);

    title.textContent = `Court ${courtIndex + 1} — ${esc(venue.name)}`;

    if (booking) {
      // ── View existing booking ────────────────────────────────
      const isPending    = booking.status === 'pending';
      const school       = booking.schoolId ? DB.getSchools().find(s => s.id === booking.schoolId) : null;
      const currentUid   = Auth.getUser() ? Auth.getUser().uid : null;
      const isOwnRequest = isPending && booking.requestedBy && booking.requestedBy === currentUid;

      const pendingNote = isOrganizer
        ? '⏳ Pending your approval as venue organiser'
        : '⏳ Pending approval';

      body.innerHTML = `
        <div class="booking-detail">
          ${isPending ? `<div class="pending-notice">${pendingNote}</div>` : ''}
          <div class="booking-info-row">
            <div class="booking-info-item"><span class="label">Date</span><span class="value">${formatDate(dateStr)}</span></div>
            <div class="booking-info-item"><span class="label">Time</span><span class="value">${timeStr}</span></div>
            <div class="booking-info-item"><span class="label">Court</span><span class="value">Court ${courtIndex + 1}</span></div>
            <div class="booking-info-item"><span class="label">Type</span><span class="value">
              <span class="badge badge-${isPending ? 'amber' : booking.type === 'league' ? 'blue' : booking.type === 'tournament' ? 'amber' : 'green'}">
                ${isPending ? 'Pending' : (booking.type || 'booking')}
              </span>
            </span></div>
          </div>
          <div class="booking-info-row">
            <div class="booking-info-item"><span class="label">Booked by</span><span class="value">${esc(booking.label || booking.schoolName || '—')}</span></div>
            ${school ? `<div class="booking-info-item"><span class="label">School</span><span class="value">${esc(school.name)}</span></div>` : ''}
            ${isPending ? `<div class="booking-info-item"><span class="label">Requested by</span><span class="value">${esc(booking.requestedByName || '?')}</span></div>` : ''}
            ${booking.notes ? `<div class="booking-info-item"><span class="label">Notes</span><span class="value">${esc(booking.notes)}</span></div>` : ''}
          </div>
        </div>`;

      if (canManage && isPending) {
        // Admin / venue organiser: approve or reject
        footer.innerHTML = `
          <button class="btn btn-secondary" data-modal="bookingModal">Close</button>
          <button class="btn btn-danger"    id="rejectBookingBtn">Reject</button>
          <button class="btn btn-primary"   id="approveBookingBtn">Approve ✓</button>`;
        document.getElementById('approveBookingBtn').onclick = () => {
          DB.approveBooking(booking.id);
          DB.writeAudit('booking_approved', 'booking',
            `Approved request by ${esc(booking.requestedByName || 'user')}: ${esc(booking.label || '')} on ${dateStr}`,
            booking.id, booking.label || '');
          Modal.close('bookingModal');
          render();
          toast('Booking approved ✓', 'success');
        };
        document.getElementById('rejectBookingBtn').onclick = () => {
          DB.rejectBooking(booking.id);
          DB.writeAudit('booking_rejected', 'booking',
            `Rejected request by ${esc(booking.requestedByName || 'user')}: ${esc(booking.label || '')} on ${dateStr}`,
            booking.id, booking.label || '');
          Modal.close('bookingModal');
          render();
          toast('Request rejected');
        };
      } else if (canManage) {
        // Admin / venue organiser: delete confirmed booking
        footer.innerHTML = `
          <button class="btn btn-secondary" data-modal="bookingModal">Close</button>
          <button class="btn btn-danger" id="deleteBookingBtn">Delete Booking</button>`;
        document.getElementById('deleteBookingBtn').onclick = () => {
          DB.deleteBooking(booking.id);
          DB.writeAudit('booking_deleted', 'booking',
            `Booking deleted: ${esc(booking.label || '')} on ${dateStr}`,
            booking.id, booking.label || '');
          Modal.close('bookingModal');
          render();
          toast('Booking deleted', 'success');
        };
      } else if (isOwnRequest) {
        // Owner: cancel own pending request
        footer.innerHTML = `
          <button class="btn btn-secondary" data-modal="bookingModal">Close</button>
          <button class="btn btn-danger" id="cancelRequestBtn">Cancel My Request</button>`;
        document.getElementById('cancelRequestBtn').onclick = () => {
          DB.deleteBooking(booking.id);
          DB.writeAudit('booking_cancelled', 'booking',
            `Request cancelled by requester: ${esc(booking.label || '')} on ${dateStr}`,
            booking.id, booking.label || '');
          Modal.close('bookingModal');
          render();
          toast('Request cancelled');
        };
      } else {
        footer.innerHTML = `<button class="btn btn-secondary" data-modal="bookingModal">Close</button>`;
      }

    } else if (canManage) {
      // ── Admin / Venue Organiser: confirmed booking ─────────
      const schools = DB.getSchools();
      body.innerHTML = `
        <div class="form-stack">
          ${isOrganizer && !Auth.isAdmin() ? `<div class="form-hint organiser-hint">🏟 Booking as organiser of <strong>${esc(venue.name)}</strong></div>` : ''}
          <div class="booking-info-row">
            <div class="booking-info-item"><span class="label">Date</span><span class="value">${formatDate(dateStr)}</span></div>
            <div class="booking-info-item"><span class="label">Court</span><span class="value">Court ${courtIndex + 1}</span></div>
          </div>
          <div class="form-group">
            <label>Select Time Slot(s)</label>
            <div class="timeslot-picker" id="slotPicker"></div>
          </div>
          <div class="form-group">
            <label>Booking Type</label>
            <select id="newBookingType">
              <option value="booking">General Booking</option>
              <option value="league">League Match</option>
              <option value="tournament">Tournament</option>
              <option value="practice">Practice</option>
            </select>
          </div>
          <div class="form-group">
            <label>School (optional)</label>
            <select id="newBookingSchool">
              <option value="">-- No school --</option>
              ${schools.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Label / Name</label>
            <input type="text" id="newBookingLabel" placeholder="e.g. Greenview vs Sunridge">
          </div>
          <div class="form-group">
            <label>Notes (optional)</label>
            <input type="text" id="newBookingNotes" placeholder="Additional info">
          </div>
        </div>`;

      const slots         = getTimeSlots();
      const picker        = document.getElementById('slotPicker');
      const selectedSlots = new Set([timeStr]);

      slots.forEach(s => {
        const btn      = document.createElement('button');
        btn.type       = 'button';
        btn.className  = 'timeslot-btn' + (s === timeStr ? ' selected' : '');
        btn.textContent = s;
        const existing       = getSlotBooking(venueId, courtIndex, dateStr, s);
        const closed         = isCourtClosed(venueId, courtIndex, dateStr, s);
        const leagueOccupied = _getLeagueFixtureForSlot(venueId, courtIndex, dateStr, s);
        if (existing || closed || leagueOccupied) {
          btn.disabled = true;
          btn.title    = leagueOccupied ? 'League match in progress' : existing ? 'Already booked' : 'Court closed';
        } else {
          btn.onclick = () => {
            if (selectedSlots.has(s)) { selectedSlots.delete(s); btn.classList.remove('selected'); }
            else                       { selectedSlots.add(s);    btn.classList.add('selected'); }
          };
        }
        picker.appendChild(btn);
      });

      footer.innerHTML = `
        <button class="btn btn-secondary" data-modal="bookingModal">Cancel</button>
        <button class="btn btn-primary"   id="saveBookingBtn">Save Booking</button>`;

      document.getElementById('saveBookingBtn').onclick = () => {
        const label    = document.getElementById('newBookingLabel').value.trim();
        const type     = document.getElementById('newBookingType').value;
        const schoolId = document.getElementById('newBookingSchool').value;
        const notes    = document.getElementById('newBookingNotes').value.trim();
        const school   = schoolId ? DB.getSchools().find(s => s.id === schoolId) : null;
        if (selectedSlots.size === 0) { toast('Select at least one time slot', 'error'); return; }

        selectedSlots.forEach(sl => {
          DB.addBooking({
            venueId, courtIndex, date: dateStr, timeSlot: sl,
            type, schoolId: schoolId || null,
            label:      label || (school ? school.name : type),
            schoolName: school ? school.name : null,
            notes,
            status:     'confirmed',
          });
        });
        DB.writeAudit('booking_created', 'booking',
          `Booked: ${label || type} on ${dateStr} (${[...selectedSlots].join(', ')}) at ${venue.name} Court ${courtIndex + 1}`,
          null, label || type);
        Modal.close('bookingModal');
        render();
        toast(`${selectedSlots.size} slot(s) booked`, 'success');
      };

    } else if (Auth.isLoggedIn()) {
      // ── Regular user: request booking ──────────────────────
      const schools  = DB.getSchools();
      const profile  = Auth.getProfile();
      const mySchool = profile && profile.schoolId
        ? schools.find(s => s.id === profile.schoolId) : null;

      body.innerHTML = `
        <div class="form-stack">
          <div class="booking-info-row">
            <div class="booking-info-item"><span class="label">Date</span><span class="value">${formatDate(dateStr)}</span></div>
            <div class="booking-info-item"><span class="label">Court</span><span class="value">Court ${courtIndex + 1}</span></div>
          </div>
          <div class="form-group">
            <label>Select Time Slot(s)</label>
            <div class="timeslot-picker" id="slotPicker"></div>
          </div>
          <div class="form-group">
            <label>Booking Type</label>
            <select id="newBookingType">
              <option value="booking">General Booking</option>
              <option value="league">League Match</option>
              <option value="practice">Practice</option>
            </select>
          </div>
          <div class="form-group">
            <label>School (optional)</label>
            <select id="newBookingSchool">
              <option value="">-- No school --</option>
              ${schools.map(s => `<option value="${s.id}"${mySchool && s.id === mySchool.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Label / Name</label>
            <input type="text" id="newBookingLabel" placeholder="e.g. Practice session">
          </div>
          <div class="form-group">
            <label>Notes (optional)</label>
            <input type="text" id="newBookingNotes" placeholder="Any extra details for the organiser">
          </div>
          <p class="form-hint">⏳ Your request will be reviewed by the venue organiser or admin before it is confirmed.</p>
        </div>`;

      const slots         = getTimeSlots();
      const picker        = document.getElementById('slotPicker');
      const selectedSlots = new Set([timeStr]);

      slots.forEach(s => {
        const btn      = document.createElement('button');
        btn.type       = 'button';
        btn.className  = 'timeslot-btn' + (s === timeStr ? ' selected' : '');
        btn.textContent = s;
        const existing       = getSlotBooking(venueId, courtIndex, dateStr, s);
        const closed         = isCourtClosed(venueId, courtIndex, dateStr, s);
        const leagueOccupied = _getLeagueFixtureForSlot(venueId, courtIndex, dateStr, s);
        if (existing || closed || leagueOccupied) {
          btn.disabled = true;
          btn.title    = leagueOccupied ? 'League match in progress' : existing ? 'Already booked / pending' : 'Court closed';
        } else {
          btn.onclick = () => {
            if (selectedSlots.has(s)) { selectedSlots.delete(s); btn.classList.remove('selected'); }
            else                       { selectedSlots.add(s);    btn.classList.add('selected'); }
          };
        }
        picker.appendChild(btn);
      });

      footer.innerHTML = `
        <button class="btn btn-secondary" data-modal="bookingModal">Cancel</button>
        <button class="btn btn-warning"   id="saveRequestBtn">Submit Request ⏳</button>`;

      document.getElementById('saveRequestBtn').onclick = () => {
        const label    = document.getElementById('newBookingLabel').value.trim();
        const type     = document.getElementById('newBookingType').value;
        const schoolId = document.getElementById('newBookingSchool').value;
        const notes    = document.getElementById('newBookingNotes').value.trim();
        const school   = schoolId ? DB.getSchools().find(s => s.id === schoolId) : null;
        const user     = Auth.getUser();
        const prof     = Auth.getProfile();
        if (selectedSlots.size === 0) { toast('Select at least one time slot', 'error'); return; }

        selectedSlots.forEach(sl => {
          DB.addBooking({
            venueId, courtIndex, date: dateStr, timeSlot: sl,
            type, schoolId: schoolId || null,
            label:           label || (school ? school.name : type),
            schoolName:      school ? school.name : null,
            notes,
            status:          'pending',
            requestedBy:     user ? user.uid : null,
            requestedByName: prof ? (prof.displayName || prof.email) : (user ? user.email : 'Unknown'),
            requestedAt:     new Date().toISOString(),
          });
        });
        DB.writeAudit('booking_requested', 'booking',
          `Request submitted by ${prof ? (prof.displayName || prof.email) : 'user'}: ${label || type} on ${dateStr} at ${venue.name} Court ${courtIndex + 1}`,
          null, label || type);
        Modal.close('bookingModal');
        render();
        toast(`${selectedSlots.size} slot request(s) submitted for approval`, 'success');
      };

    } else {
      // ── Visitor ────────────────────────────────────────────
      body.innerHTML = `
        <div style="text-align:center;padding:1rem">
          <p class="text-muted">This slot is available.</p>
          <p style="margin-top:.5rem;font-size:.9rem">
            <a href="#" id="loginFromSlot" style="color:var(--primary);font-weight:600">Log in</a> or
            <a href="#" id="registerFromSlot" style="color:var(--primary);font-weight:600">register</a>
            to request a booking.
          </p>
        </div>`;
      footer.innerHTML = `<button class="btn btn-secondary" data-modal="bookingModal">Close</button>`;

      document.getElementById('loginFromSlot').onclick = e => {
        e.preventDefault();
        Modal.close('bookingModal');
        document.getElementById('loginEmail').value    = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginError').textContent = '';
        Modal.open('loginModal');
        setTimeout(() => document.getElementById('loginEmail').focus(), 50);
      };
      document.getElementById('registerFromSlot').onclick = e => {
        e.preventDefault();
        Modal.close('bookingModal');
        const sel = document.getElementById('regSchool');
        sel.innerHTML = '<option value="">-- No school --</option>' +
          DB.getSchools().map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
        ['regName','regEmail','regPassword','regConfirm'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        document.getElementById('registerError').textContent = '';
        Modal.open('registerModal');
        setTimeout(() => document.getElementById('regName').focus(), 50);
      };
    }

    Modal.open('bookingModal');
  }

  return { init, refresh, render };
})();
