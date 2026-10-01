/**
 * courtbooking.js — Court Booking view
 *
 * Any logged-in user can book:
 *   • Courts at their own school's venue (confirmed immediately for organizers,
 *     pending approval otherwise)
 *   • Courts at Groenkloof or any venue flagged as openBookings (pending approval)
 *
 * Booking form captures:
 *   - Venue, date, court, slot (morning / afternoon)
 *   - Booker name (default: logged-in user's display name)
 *   - On-behalf name + contact (optional)
 *   - Reason (required)
 */

const CourtBooking = (() => {

  // ── State ───────────────────────────────────────────────────
  let _selectedVenueId  = null;
  let _selectedDate     = toDateStr(new Date());
  let _selectedCourt    = 0;
  let _selectedSlot     = 'morning';

  // ── Helpers ─────────────────────────────────────────────────

  function _getBookableVenues() {
    if (!Auth.isLoggedIn()) return [];
    const profile = Auth.getProfile();
    const venues  = DB.getVenues();

    // Own venue
    const ownVenueId = (() => {
      if (!profile || !profile.schoolId) return null;
      const school = DB.getSchools().find(s => s.id === profile.schoolId);
      return school ? school.venueId : null;
    })();

    // Any venue marked openBookings or named "groenkloof"
    const result = [];
    venues.forEach(v => {
      const isOwn  = v.id === ownVenueId;
      const isOpen = v.openBookings || (v.name || '').toLowerCase().includes('groenkloof');
      if (isOwn || isOpen || Auth.isAdmin()) result.push({ ...v, isOwn, isOpen });
    });
    return result;
  }

  function _isVenueOrganizer(venueId) {
    if (!Auth.isLoggedIn()) return false;
    const profile = Auth.getProfile();
    if (!profile || !profile.schoolId) return false;
    const school = DB.getSchools().find(s => s.id === profile.schoolId);
    return !!(school && school.venueId === venueId);
  }

  function _slotAvailable(venueId, courtIdx, dateStr, slot) {
    if (isCourtClosed(venueId, courtIdx, dateStr, slot)) return false;
    if (getSlotBooking(venueId, courtIdx, dateStr, slot)) return false;
    // Check league fixtures
    const leagues = DB.getLeagues();
    const slotStart = slot === 'morning' ? 7 * 60 : 14 * 60;
    const slotEnd   = slot === 'morning' ? 14 * 60 : 18 * 60;
    for (const league of leagues) {
      for (const f of (league.fixtures || [])) {
        if (f.venueId !== venueId || f.date !== dateStr) continue;
        const fMins = _timeToMins(f.timeSlot || '14:00');
        const fEnd  = fMins + 180;
        if (fMins < slotEnd && fEnd > slotStart) return false;
      }
    }
    return true;
  }

  function _timeToMins(t) {
    const [h, m] = (t || '00:00').split(':').map(Number);
    return h * 60 + m;
  }

  // ── Entry point (called from calendar "Court Booking →" button) ─
  function openWith(venueId, courtIdx, dateStr, slot) {
    _selectedVenueId = venueId;
    _selectedCourt   = courtIdx;
    _selectedDate    = dateStr;
    _selectedSlot    = slot;
    navigate('courtbooking');
    render();
  }

  // ── Main render ─────────────────────────────────────────────
  function render() {
    const el = document.getElementById('courtBookingContent');
    if (!el) return;

    if (!Auth.isLoggedIn()) {
      el.innerHTML = `<div class="empty-state"><p>Please log in to make a booking.</p></div>`;
      return;
    }

    const venues  = _getBookableVenues();
    const profile = Auth.getProfile();

    if (venues.length === 0) {
      el.innerHTML = `<div class="empty-state"><p class="text-muted">No bookable venues are available for your account. Contact an administrator.</p></div>`;
      return;
    }

    // Default venue
    if (!_selectedVenueId || !venues.find(v => v.id === _selectedVenueId)) {
      _selectedVenueId = venues[0].id;
    }

    const venue     = venues.find(v => v.id === _selectedVenueId);
    const courts    = venue ? (venue.courts || 4) : 4;
    const bookerDef = profile ? (profile.displayName || profile.email || '') : '';

    // Build availability table for selected venue + date
    const availRows = [];
    for (let ci = 0; ci < courts; ci++) {
      ['morning', 'afternoon'].forEach(slot => {
        const avail   = _slotAvailable(_selectedVenueId, ci, _selectedDate, slot);
        const booking = getSlotBooking(_selectedVenueId, ci, _selectedDate, slot);
        availRows.push({ ci, slot, avail, booking });
      });
    }

    el.innerHTML = `
      <div class="cb-layout">
        <!-- ── Booking form ─────────────────────────────────── -->
        <div class="cb-form-panel">
          <h3 style="margin:0 0 1rem">New Booking Request</h3>

          <div class="form-group">
            <label>Venue</label>
            <select id="cbVenue">
              ${venues.map(v => `<option value="${v.id}"${v.id === _selectedVenueId ? ' selected' : ''}>${esc(v.name)}${v.isOwn ? ' (My Venue)' : ''}</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label>Date</label>
            <input type="date" id="cbDate" value="${_selectedDate}" min="${toDateStr(new Date())}">
          </div>

          <div class="form-group">
            <label>Court</label>
            <select id="cbCourt">
              ${Array.from({ length: courts }, (_, i) => `<option value="${i}"${i === _selectedCourt ? ' selected' : ''}>Court ${i + 1}</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label>Slot</label>
            <div class="timeslot-picker">
              <button type="button" class="timeslot-btn${_selectedSlot === 'morning' ? ' selected' : ''}" id="cbSlotMorning">
                Morning<span style="display:block;font-size:.72rem;opacity:.7">07:00 – 14:00</span>
              </button>
              <button type="button" class="timeslot-btn${_selectedSlot === 'afternoon' ? ' selected' : ''}" id="cbSlotAfternoon">
                Afternoon<span style="display:block;font-size:.72rem;opacity:.7">14:00 – 18:00</span>
              </button>
            </div>
          </div>

          <div id="cbAvailBadge" style="margin-bottom:.75rem"></div>

          <div class="form-group">
            <label>Your Name <span class="text-muted">(booker)</span></label>
            <input type="text" id="cbBooker" value="${esc(bookerDef)}" placeholder="Your full name">
          </div>

          <div class="form-group">
            <label>Booking Type <span style="color:var(--danger)">*</span></label>
            <select id="cbType">
              <option value="">-- Select type --</option>
              <option value="Practice">Practice</option>
              <option value="Match">Match</option>
              <option value="Coaching">Coaching</option>
              <option value="Tournament">Tournament</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label>Additional Details <span class="text-muted" style="font-weight:400">(optional)</span></label>
            <input type="text" id="cbReason" placeholder="Any extra info about this booking…">
          </div>

          <div style="border:1px solid var(--border);border-radius:var(--radius);padding:.75rem;margin-bottom:.75rem">
            <p style="font-size:.8rem;font-weight:600;margin:0 0 .5rem;color:var(--neutral)">On Behalf Of (optional)</p>
            <div class="form-group" style="margin-bottom:.5rem">
              <label>Name</label>
              <input type="text" id="cbOnBehalfName" placeholder="Player / coach name">
            </div>
            <div class="form-group" style="margin:0">
              <label>Contact Number</label>
              <input type="tel" id="cbOnBehalfContact" placeholder="e.g. 082 000 0000">
            </div>
          </div>

          <div class="form-group">
            <label>Notes (optional)</label>
            <input type="text" id="cbNotes" placeholder="Any additional info">
          </div>

          <button class="btn btn-primary btn-full" id="cbSubmitBtn" style="width:100%">Submit Booking Request</button>
          <p id="cbError" class="text-danger" style="margin-top:.5rem;font-size:.85rem"></p>
        </div>

        <!-- ── Availability panel ───────────────────────────── -->
        <div class="cb-avail-panel">
          <h3 style="margin:0 0 .75rem">Availability — ${esc(venue ? venue.name : '')} · ${formatDate(_selectedDate)}</h3>
          <div class="cb-avail-grid">
            ${availRows.map(r => {
              const slotName = getSlotDisplayName(r.slot);
              const slotLbl  = getSlotLabel(r.slot);
              if (!r.avail) {
                const lbl = r.booking ? (r.booking.reason || r.booking.label || (r.booking.status === 'pending' ? 'Pending ⏳' : 'Booked')) : 'Unavailable';
                const cls  = r.booking && r.booking.status === 'pending' ? 'pending-request' : r.booking ? 'booked' : 'closed';
                return `<div class="cb-avail-cell ${cls}"><span class="cb-court-lbl">Court ${r.ci + 1}</span><span class="cb-slot-name">${slotName}</span><span class="cb-slot-info">${esc(lbl.substring(0,24))}</span></div>`;
              }
              const isSelected = r.ci === _selectedCourt && r.slot === _selectedSlot;
              return `<button class="cb-avail-cell available${isSelected ? ' selected' : ''}" data-ci="${r.ci}" data-slot="${r.slot}">
                <span class="cb-court-lbl">Court ${r.ci + 1}</span>
                <span class="cb-slot-name">${slotName}</span>
                <span class="cb-slot-info" style="color:var(--primary-dark)">${slotLbl}</span>
              </button>`;
            }).join('')}
          </div>
          <p class="text-muted" style="font-size:.78rem;margin-top:.5rem">Click an available slot to pre-fill the form.</p>
        </div>
      </div>`;

    // ── Wire up events ──────────────────────────────────────
    document.getElementById('cbVenue').addEventListener('change', e => {
      _selectedVenueId = e.target.value;
      render();
    });
    document.getElementById('cbDate').addEventListener('change', e => {
      _selectedDate = e.target.value;
      render();
    });
    document.getElementById('cbCourt').addEventListener('change', e => {
      _selectedCourt = parseInt(e.target.value);
      _updateAvailBadge();
    });
    document.getElementById('cbSlotMorning').addEventListener('click', () => {
      _selectedSlot = 'morning';
      document.getElementById('cbSlotMorning').classList.add('selected');
      document.getElementById('cbSlotAfternoon').classList.remove('selected');
      _updateAvailBadge();
    });
    document.getElementById('cbSlotAfternoon').addEventListener('click', () => {
      _selectedSlot = 'afternoon';
      document.getElementById('cbSlotAfternoon').classList.add('selected');
      document.getElementById('cbSlotMorning').classList.remove('selected');
      _updateAvailBadge();
    });

    // Availability cell clicks
    el.querySelectorAll('.cb-avail-cell[data-ci]').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedCourt = parseInt(btn.dataset.ci);
        _selectedSlot  = btn.dataset.slot;
        document.getElementById('cbCourt').value = _selectedCourt;
        if (_selectedSlot === 'morning') {
          document.getElementById('cbSlotMorning').classList.add('selected');
          document.getElementById('cbSlotAfternoon').classList.remove('selected');
        } else {
          document.getElementById('cbSlotAfternoon').classList.add('selected');
          document.getElementById('cbSlotMorning').classList.remove('selected');
        }
        _updateAvailBadge();
      });
    });

    document.getElementById('cbSubmitBtn').addEventListener('click', _submit);
    _updateAvailBadge();
  }

  function _updateAvailBadge() {
    const badge = document.getElementById('cbAvailBadge');
    if (!badge) return;
    const avail = _slotAvailable(_selectedVenueId, _selectedCourt, _selectedDate, _selectedSlot);
    badge.innerHTML = avail
      ? `<span style="color:#15803d;font-weight:600">✓ This slot is available</span>`
      : `<span style="color:#dc2626;font-weight:600">✗ This slot is not available — choose another</span>`;
  }

  async function _submit() {
    const btn    = document.getElementById('cbSubmitBtn');
    const errEl  = document.getElementById('cbError');
    const booker = document.getElementById('cbBooker').value.trim();
    const bookingType     = document.getElementById('cbType').value;
    const details         = document.getElementById('cbReason').value.trim();
    const onBehalfName    = document.getElementById('cbOnBehalfName').value.trim();
    const onBehalfContact = document.getElementById('cbOnBehalfContact').value.trim();
    const notes  = document.getElementById('cbNotes').value.trim();
    const reason = bookingType + (details ? ': ' + details : '');

    errEl.textContent = '';
    if (!bookingType) { errEl.textContent = 'Please select a booking type.'; return; }
    if (!_slotAvailable(_selectedVenueId, _selectedCourt, _selectedDate, _selectedSlot)) {
      errEl.textContent = 'This slot is no longer available. Please choose a different slot.';
      return;
    }

    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      const user    = Auth.getUser();
      const profile = Auth.getProfile();
      const status = 'pending';
      const venue   = DB.getVenues().find(v => v.id === _selectedVenueId);

      const result = DB.addBooking({
        venueId:         _selectedVenueId,
        courtIndex:      _selectedCourt,
        date:            _selectedDate,
        timeSlot:        _selectedSlot,
        type:            bookingType.toLowerCase() || 'booking',
        reason,
        label:           reason,
        bookerName:      booker || (profile ? (profile.displayName || profile.email) : ''),
        onBehalfName:    onBehalfName    || null,
        onBehalfContact: onBehalfContact || null,
        notes:           notes           || null,
        status,
        requestedBy:     user    ? user.uid                             : null,
        requestedByName: profile ? (profile.displayName || profile.email) : null,
        requestedAt:     new Date().toISOString(),
      });

      if (!result) {
        errEl.textContent = 'This slot was just booked by someone else. Please choose a different slot.';
        btn.disabled = false; btn.textContent = 'Submit Booking Request';
        render();
        return;
      }

      DB.writeAudit('booking_requested', 'booking',
        `Requested: ${reason} on ${_selectedDate} (${getSlotDisplayName(_selectedSlot)}) at ${venue ? venue.name : _selectedVenueId} Court ${_selectedCourt + 1}`,
        null, reason);

      toast('Booking request submitted — awaiting approval ✓', 'success');
      // Notify venue organizers via Cloud Function (fire-and-forget)
      try {
        await firebase.functions().httpsCallable('notifyBookingRequest')({
          bookingId: result.id,
        });
      } catch (e) { /* non-critical */ }

      // Reset form after success
      _selectedSlot = 'morning';
      document.getElementById('cbType').value  = '';
      document.getElementById('cbReason').value = '';
      document.getElementById('cbOnBehalfName').value = '';
      document.getElementById('cbOnBehalfContact').value = '';
      document.getElementById('cbNotes').value = '';
      render();
    } catch (err) {
      console.error('[CourtBooking] submit failed:', err);
      errEl.textContent = 'Failed to submit request — ' + (err.message || err);
      btn.disabled = false; btn.textContent = 'Submit Booking Request';
    }
  }

  function init() {
    render();
  }

  function refresh() {
    const section = document.getElementById('view-courtbooking');
    if (section && !section.classList.contains('hidden')) render();
  }

  return { init, refresh, render, openWith };
})();
