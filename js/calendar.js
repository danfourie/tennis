/**
 * calendar.js — Weekly court availability calendar
 */

const Calendar = (() => {
  let currentWeekStart = weekStart(new Date());
  let currentVenueFilter = 'all';

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
    const sel = document.getElementById('venueFilter');
    const venues = DB.getVenues();
    // Remove old options except "All"
    while (sel.options.length > 1) sel.remove(1);
    venues.forEach(v => {
      const opt = new Option(v.name, v.id);
      sel.add(opt);
    });
  }

  function refresh() {
    populateVenueFilter();
    render();
  }

  function render() {
    const container = document.getElementById('calendarContainer');
    const venues = DB.getVenues();
    const filteredVenues = currentVenueFilter === 'all'
      ? venues
      : venues.filter(v => v.id === currentVenueFilter);

    // Week dates: Mon–Sun
    const days = Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i));
    const todayStr = toDateStr(new Date());

    // Update week label
    document.getElementById('weekLabel').textContent =
      `${formatDateShort(days[0])} – ${formatDateShort(days[6])} ${days[0].getFullYear()}`;

    if (filteredVenues.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎾</div><p>No venues configured. Add one in Admin.</p></div>`;
      return;
    }

    const slots = getTimeSlots();
    const settings = DB.getSettings();

    let html = `<div class="calendar-grid">`;

    // Header
    html += `<div class="cal-header-row">
      <div class="cal-header-time">Court</div>`;
    days.forEach((d, i) => {
      const dStr = toDateStr(d);
      const isToday = dStr === todayStr;
      html += `<div class="cal-header-day${isToday ? ' today' : ''}">
        <div class="cal-day-name">${DAY_NAMES[i]}</div>
        <div class="cal-day-num">${d.getDate()}</div>
      </div>`;
    });
    html += `</div>`; // end header

    // Venue sections
    filteredVenues.forEach(venue => {
      const courtCount = venue.courts || 4;
      html += `<div class="cal-venue-section">`;
      html += `<div class="cal-venue-header"><div class="cal-venue-label">📍 ${esc(venue.name)}</div></div>`;

      for (let ci = 0; ci < courtCount; ci++) {
        html += `<div class="cal-court-row">`;
        html += `<div class="cal-court-label">Court ${ci + 1}</div>`;

        days.forEach(d => {
          const dStr = toDateStr(d);
          const isToday = dStr === todayStr;
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
      <div class="legend-item"><div class="legend-dot" style="background:#f3f4f6;border:1px solid #d1d5db"></div> Closed</div>
    </div>`;

    html += `</div>`; // end grid
    container.innerHTML = html;

    // Attach click handlers
    container.querySelectorAll('[data-slot]').forEach(el => {
      el.addEventListener('click', () => {
        const { venue: vId, court, date, slot } = el.dataset;
        openSlotModal(vId, parseInt(court), date, slot);
      });
    });
  }

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

    const booking = getSlotBooking(venue.id, ci, dStr, slot);
    if (booking) {
      const type = booking.type || 'booking';
      const cls = type === 'league' ? 'league' : type === 'tournament' ? 'tournament' : 'booked';
      const label = esc(booking.label || booking.schoolName || 'Booked');
      return `<button class="slot-chip ${cls}" data-slot="1" data-venue="${venue.id}" data-court="${ci}" data-date="${dStr}" data-slot-time="${slot}" title="${label} @ ${slot}">${label}<span class="slot-time">${slot}</span></button>`;
    }

    // Available
    if (Auth.isAdmin()) {
      return `<button class="slot-chip available admin-can-book" data-slot="1" data-venue="${venue.id}" data-court="${ci}" data-date="${dStr}" data-slot-time="${slot}" title="Book this slot">${slot}</button>`;
    }
    return `<span class="slot-chip available" title="Available">${slot}</span>`;
  }

  function openSlotModal(venueId, courtIndex, dateStr, timeStr) {
    const venue = DB.getVenues().find(v => v.id === venueId);
    if (!venue) return;
    const booking = getSlotBooking(venueId, courtIndex, dateStr, timeStr);
    const title = document.getElementById('bookingModalTitle');
    const body = document.getElementById('bookingModalBody');
    const footer = document.getElementById('bookingModalFooter');

    title.textContent = `Court ${courtIndex + 1} — ${esc(venue.name)}`;

    if (booking) {
      // View / edit existing booking
      const school = booking.schoolId ? DB.getSchools().find(s => s.id === booking.schoolId) : null;
      body.innerHTML = `
        <div class="booking-detail">
          <div class="booking-info-row">
            <div class="booking-info-item"><span class="label">Date</span><span class="value">${formatDate(dateStr)}</span></div>
            <div class="booking-info-item"><span class="label">Time</span><span class="value">${timeStr}</span></div>
            <div class="booking-info-item"><span class="label">Court</span><span class="value">Court ${courtIndex + 1}</span></div>
            <div class="booking-info-item"><span class="label">Type</span><span class="value"><span class="badge badge-${booking.type === 'league' ? 'blue' : booking.type === 'tournament' ? 'amber' : 'green'}">${booking.type || 'booking'}</span></span></div>
          </div>
          <div class="booking-info-row">
            <div class="booking-info-item"><span class="label">Booked by</span><span class="value">${esc(booking.label || booking.schoolName || '—')}</span></div>
            ${school ? `<div class="booking-info-item"><span class="label">School</span><span class="value">${esc(school.name)}</span></div>` : ''}
            ${booking.notes ? `<div class="booking-info-item"><span class="label">Notes</span><span class="value">${esc(booking.notes)}</span></div>` : ''}
          </div>
        </div>`;

      footer.innerHTML = Auth.isAdmin()
        ? `<button class="btn btn-secondary" data-modal="bookingModal">Close</button>
           <button class="btn btn-danger" id="deleteBookingBtn">Delete Booking</button>`
        : `<button class="btn btn-secondary" data-modal="bookingModal">Close</button>`;

      if (Auth.isAdmin()) {
        document.getElementById('deleteBookingBtn').onclick = () => {
          DB.deleteBooking(booking.id);
          Modal.close('bookingModal');
          render();
          toast('Booking deleted', 'success');
        };
      }
    } else if (Auth.isAdmin()) {
      // Create new booking
      const schools = DB.getSchools();
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

      // Populate slot picker
      const slots = getTimeSlots();
      const picker = document.getElementById('slotPicker');
      const selectedSlots = new Set([timeStr]);
      slots.forEach(s => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'timeslot-btn' + (s === timeStr ? ' selected' : '');
        btn.textContent = s;
        const existing = getSlotBooking(venueId, courtIndex, dateStr, s);
        const closed = isCourtClosed(venueId, courtIndex, dateStr, s);
        if (existing || closed) {
          btn.disabled = true;
          btn.title = existing ? 'Already booked' : 'Court closed';
        } else {
          btn.onclick = () => {
            if (selectedSlots.has(s)) { selectedSlots.delete(s); btn.classList.remove('selected'); }
            else { selectedSlots.add(s); btn.classList.add('selected'); }
          };
        }
        picker.appendChild(btn);
      });

      footer.innerHTML = `
        <button class="btn btn-secondary" data-modal="bookingModal">Cancel</button>
        <button class="btn btn-primary" id="saveBookingBtn">Save Booking</button>`;

      document.getElementById('saveBookingBtn').onclick = () => {
        const label = document.getElementById('newBookingLabel').value.trim();
        const type = document.getElementById('newBookingType').value;
        const schoolId = document.getElementById('newBookingSchool').value;
        const notes = document.getElementById('newBookingNotes').value.trim();
        const school = schoolId ? DB.getSchools().find(s => s.id === schoolId) : null;
        if (selectedSlots.size === 0) { toast('Select at least one time slot', 'error'); return; }
        selectedSlots.forEach(sl => {
          DB.addBooking({
            venueId, courtIndex, date: dateStr, timeSlot: sl,
            type, schoolId: schoolId || null,
            label: label || (school ? school.name : type),
            schoolName: school ? school.name : null,
            notes,
          });
        });
        Modal.close('bookingModal');
        render();
        toast(`${selectedSlots.size} slot(s) booked`, 'success');
      };
    } else {
      body.innerHTML = `<p class="text-muted text-center">This slot is available. Login as master to book.</p>`;
      footer.innerHTML = `<button class="btn btn-secondary" data-modal="bookingModal">Close</button>`;
    }

    Modal.open('bookingModal');
  }

  return { init, refresh, render };
})();
