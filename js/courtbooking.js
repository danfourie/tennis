/**
 * courtbooking.js — Court Booking view
 *
 * Supports multi-slot booking: user selects any number of court/date/slot
 * combinations into a cart, fills in booking details once, and submits
 * them as a single grouped request. Organizers approve/reject each slot
 * individually or use the "Approve All / Reject All" group actions.
 */

const CourtBooking = (() => {

  // ── State ───────────────────────────────────────────────────
  let _selectedVenueId = null;
  let _selectedDate    = toDateStr(new Date());
  let _cart            = []; // [{ courtIndex, date, slot }]

  // ── Helpers ─────────────────────────────────────────────────

  function _getBookableVenues() {
    if (!Auth.isLoggedIn()) return [];
    const profile = Auth.getProfile();
    const venues  = DB.getVenues();

    const ownVenueId = (() => {
      if (!profile || !profile.schoolId) return null;
      const school = DB.getSchools().find(s => s.id === profile.schoolId);
      return school ? school.venueId : null;
    })();

    const result = [];
    venues.forEach(v => {
      const isOwn  = v.id === ownVenueId;
      const isOpen = v.openBookings || (v.name || '').toLowerCase().includes('groenkloof');
      if (isOwn || isOpen || Auth.isAdmin()) result.push({ ...v, isOwn, isOpen });
    });
    return result;
  }

  function _slotAvailable(venueId, courtIdx, dateStr, slot) {
    if (isCourtClosed(venueId, courtIdx, dateStr, slot)) return false;
    if (getSlotBooking(venueId, courtIdx, dateStr, slot)) return false;
    const leagues   = DB.getLeagues();
    const slotStart = slot === 'morning' ? 7 * 60 : 14 * 60;
    const slotEnd   = slot === 'morning' ? 14 * 60 : 18 * 60;
    for (const league of leagues) {
      for (const f of (league.fixtures || [])) {
        if (f.venueId !== venueId || f.date !== dateStr) continue;
        const fMins = _timeToMins(f.timeSlot || '14:00');
        if (fMins < slotEnd && (fMins + 180) > slotStart) return false;
      }
    }
    return true;
  }

  function _timeToMins(t) {
    const [h, m] = (t || '00:00').split(':').map(Number);
    return h * 60 + m;
  }

  function _cartKey(ci, date, slot) { return `${ci}|${date}|${slot}`; }

  function _inCart(ci, date, slot) {
    const key = _cartKey(ci, date, slot);
    return _cart.some(x => _cartKey(x.courtIndex, x.date, x.slot) === key);
  }

  function _toggleCart(ci, date, slot) {
    const key = _cartKey(ci, date, slot);
    const idx = _cart.findIndex(x => _cartKey(x.courtIndex, x.date, x.slot) === key);
    if (idx >= 0) _cart.splice(idx, 1);
    else _cart.push({ courtIndex: ci, date, slot });
  }

  // ── Entry point (called from calendar "Court Booking →" button) ─
  function openWith(venueId, courtIdx, dateStr, slot) {
    _selectedVenueId = venueId;
    _selectedDate    = dateStr;
    _cart = [{ courtIndex: courtIdx, date: dateStr, slot }];
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

    if (!_selectedVenueId || !venues.find(v => v.id === _selectedVenueId)) {
      _selectedVenueId = venues[0].id;
    }

    const today     = toDateStr(new Date());
    _cart           = _cart.filter(x => x.date >= today); // drop past-date cart items

    const venue     = venues.find(v => v.id === _selectedVenueId);
    const courts    = venue ? (venue.courts || 4) : 4;
    const bookerDef = profile ? (profile.displayName || profile.email || '') : '';

    // Availability grid for selected venue + date
    const availRows = [];
    for (let ci = 0; ci < courts; ci++) {
      ['morning', 'afternoon'].forEach(slot => {
        const avail   = _slotAvailable(_selectedVenueId, ci, _selectedDate, slot);
        const booking = getSlotBooking(_selectedVenueId, ci, _selectedDate, slot);
        const inCart  = _inCart(ci, _selectedDate, slot);
        availRows.push({ ci, slot, avail, booking, inCart });
      });
    }

    // Cart chips
    const cartChipsHtml = _cart.length === 0
      ? `<div class="cb-cart-empty">No slots selected — click an available slot on the right to add it to your request.</div>`
      : _cart.map((x, idx) => `
          <div class="cb-cart-chip">
            <span>Court ${x.courtIndex + 1} · ${formatDate(x.date)} · ${getSlotDisplayName(x.slot)}</span>
            <button type="button" class="cb-cart-remove" data-idx="${idx}" title="Remove">×</button>
          </div>`).join('');

    const nSlots      = _cart.length;
    const submitLabel = nSlots > 1 ? `Submit ${nSlots} Booking Requests` : 'Submit Booking Request';

    el.innerHTML = `
      <div class="cb-layout">
        <!-- ── Booking form ─────────────────────────────────── -->
        <div class="cb-form-panel">
          <h3 style="margin:0 0 .75rem">New Booking Request</h3>

          <div class="form-group">
            <label style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.25rem">
              <span>Selected Slots${nSlots > 0 ? ` <span class="badge" style="background:var(--primary);color:#fff;vertical-align:middle;font-size:.7rem">${nSlots}</span>` : ''}</span>
              ${nSlots > 0 ? `<button type="button" id="cbClearCart" style="font-size:.78rem;color:var(--danger);background:none;border:none;cursor:pointer;padding:0">Clear all</button>` : ''}
            </label>
            <div class="cb-cart-chips">${cartChipsHtml}</div>
          </div>

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

          <button class="btn btn-primary btn-full" id="cbSubmitBtn" style="width:100%"${nSlots === 0 ? ' disabled' : ''}>
            ${submitLabel}
          </button>
          <p id="cbError" class="text-danger" style="margin-top:.5rem;font-size:.85rem"></p>
        </div>

        <!-- ── Availability panel ───────────────────────────── -->
        <div class="cb-avail-panel">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.75rem">
            <div class="form-group" style="margin:0">
              <label style="font-size:.8rem">Venue</label>
              <select id="cbVenue">
                ${venues.map(v => `<option value="${v.id}"${v.id === _selectedVenueId ? ' selected' : ''}>${esc(v.name)}${v.isOwn ? ' (My Venue)' : ''}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="margin:0">
              <label style="font-size:.8rem">Date</label>
              <input type="date" id="cbDate" value="${_selectedDate}" min="${today}">
            </div>
          </div>
          <h4 style="margin:0 0 .5rem;font-size:.88rem;color:var(--neutral)">${esc(venue ? venue.name : '')} · ${formatDate(_selectedDate)}</h4>
          <div class="cb-avail-grid">
            ${availRows.map(r => {
              const slotName = getSlotDisplayName(r.slot);
              const slotLbl  = getSlotLabel(r.slot);
              if (!r.avail && !r.inCart) {
                const lbl = r.booking
                  ? (r.booking.reason || r.booking.label || (r.booking.status === 'pending' ? 'Pending ⏳' : 'Booked'))
                  : 'Unavailable';
                const cls = r.booking && r.booking.status === 'pending' ? 'pending-request' : r.booking ? 'booked' : 'closed';
                return `<div class="cb-avail-cell ${cls}">
                  <span class="cb-court-lbl">Court ${r.ci + 1}</span>
                  <span class="cb-slot-name">${slotName}</span>
                  <span class="cb-slot-info">${esc(lbl.substring(0, 24))}</span>
                </div>`;
              }
              return `<button class="cb-avail-cell available${r.inCart ? ' in-cart' : ''}" data-ci="${r.ci}" data-slot="${r.slot}">
                <span class="cb-court-lbl">Court ${r.ci + 1}</span>
                <span class="cb-slot-name">${slotName}${r.inCart ? ' ✓' : ''}</span>
                <span class="cb-slot-info">${r.inCart ? 'Selected' : slotLbl}</span>
              </button>`;
            }).join('')}
          </div>
          <p class="text-muted" style="font-size:.78rem;margin-top:.5rem">Click a slot to add it to your request. Click again to remove. Change the date above to browse other days.</p>
        </div>
      </div>`;

    // ── My Bookings section ─────────────────────────────────
    const cbUser     = Auth.getUser();
    const cbToday    = toDateStr(new Date());
    const allMine    = cbUser
      ? DB.getBookings()
          .filter(b => b.requestedBy === cbUser.uid)
          .slice()
          .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.requestedAt || '').localeCompare(b.requestedAt || ''))
      : [];

    // Active: upcoming date AND pending/confirmed
    const cbActive  = allMine.filter(b =>
      b.date >= cbToday && (b.status === 'pending' || b.status === 'confirmed')
    );
    // History: past date OR cancelled/rejected
    const cbHistory = allMine
      .filter(b => b.date < cbToday || b.status === 'cancelled' || b.status === 'rejected')
      .sort((a, b) => (b.date || '').localeCompare(a.date || '')); // newest first

    function _cbGroupRows(list, includeCancel) {
      let out = '';
      const groups = [];
      const seenGroups = {};
      list.forEach(b => {
        const key = b.groupId || ('__' + b.id);
        if (!seenGroups[key]) { seenGroups[key] = { groupId: b.groupId || null, bookings: [] }; groups.push(seenGroups[key]); }
        seenGroups[key].bookings.push(b);
      });
      groups.forEach(group => {
        const isMulti   = !!(group.groupId && group.bookings.length > 1);
        const anyActive = group.bookings.some(b => b.status === 'pending' || b.status === 'confirmed');
        if (isMulti) {
          const label = group.bookings[0].label || group.bookings[0].type || 'Booking';
          out += `<div class="cb-group-block" style="margin-bottom:.5rem">
            <div class="cb-group-header">
              <span><strong>📦 ${esc(label)}</strong> — ${group.bookings.length} slots</span>
              ${(includeCancel && anyActive) ? `<button class="btn btn-sm btn-danger cb-cancel-group-btn" data-group-id="${esc(group.groupId)}">Cancel All</button>` : ''}
            </div>`;
        }
        group.bookings.forEach(b => {
          const venueName   = (DB.getVenues().find(v => v.id === b.venueId) || {}).name || b.venueId;
          const isConfirmed = b.status === 'confirmed';
          const isPending   = b.status === 'pending';
          const isRejected  = b.status === 'rejected';
          const isCancelled = b.status === 'cancelled';
          const statusBadge = isConfirmed
            ? `<span class="badge" style="background:#dcfce7;color:#166534;font-size:.7rem">Confirmed ✓</span>`
            : isPending
              ? `<span class="badge" style="background:#fef9c3;color:#854d0e;font-size:.7rem">Pending ⏳</span>`
              : isRejected
                ? `<span class="badge" style="background:#fee2e2;color:#991b1b;font-size:.7rem">Declined ✗</span>`
                : isCancelled
                  ? `<span class="badge" style="background:#f3f4f6;color:#6b7280;font-size:.7rem">Cancelled</span>`
                  : `<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:.7rem">${esc(b.status || '—')}</span>`;
          const showCancel = includeCancel && (isPending || isConfirmed) && bookingCancellationAllowed(b);
          out += `<div class="admin-list-item${isMulti ? ' group-slot-item' : ''}" style="align-items:flex-start;gap:.75rem">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
                <span style="font-weight:600">${esc(b.label || b.reason || b.type || 'Booking')}</span>${statusBadge}
              </div>
              <div class="text-muted" style="font-size:.82rem">
                🏟️ ${esc(venueName)} &nbsp;📅 ${b.date ? formatDate(b.date) : '—'} &nbsp;⏰ ${getSlotDisplayName(b.timeSlot || '')} &nbsp;🎾 Court ${(typeof b.courtIndex === 'number') ? b.courtIndex + 1 : '—'}
              </div>
            </div>
            <div style="display:flex;gap:.4rem;flex-shrink:0">
              ${showCancel ? `<button class="btn btn-sm btn-danger cb-my-cancel-btn" data-id="${esc(b.id)}">Cancel</button>` : ''}
            </div>
          </div>`;
        });
        if (isMulti) out += `</div>`;
      });
      return out;
    }

    if (allMine.length > 0) {
      let mbHtml = `<div class="card" style="margin-top:1.5rem">
        <div class="card-header"><div class="card-title" style="margin:0">📋 My Bookings</div></div>
        <div class="card-body" style="padding:.25rem .75rem .75rem">`;

      if (cbActive.length === 0) {
        mbHtml += `<p class="text-muted" style="padding:.4rem 0;margin:0">No upcoming bookings.</p>`;
      } else {
        mbHtml += _cbGroupRows(cbActive, true);
      }

      if (cbHistory.length > 0) {
        mbHtml += `<details style="margin-top:.75rem">
          <summary style="font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--neutral);cursor:pointer;user-select:none;padding:.2rem 0">
            History (${cbHistory.length})
          </summary>
          <div style="margin-top:.5rem;opacity:.85">${_cbGroupRows(cbHistory, false)}</div>
        </details>`;
      }

      mbHtml += `</div></div>`;
      el.insertAdjacentHTML('beforeend', mbHtml);
    }

    // ── Wire up events ──────────────────────────────────────
    // Cancel individual booking (My Bookings section)
    el.querySelectorAll('.cb-my-cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const b  = DB.getBookings().find(x => x.id === id);
        if (!bookingCancellationAllowed(b)) {
          toast('Cancellations are not permitted within 4 hours of the booking time or after the event has taken place.', 'error');
          return;
        }
        if (!confirm(`Cancel this booking?\n\n"${b ? (b.label || b.type || 'Booking') : 'Booking'}" on ${b ? (b.date || '—') : '—'}`)) return;
        btn.disabled = true; btn.textContent = 'Cancelling…';
        try {
          await DB.rejectBooking(id, 'cancelled');
          firebase.functions().httpsCallable('notifyUserCancellation')({ bookingId: id }).catch(() => {});
          render();
          toast('Booking cancelled');
        } catch (err) {
          console.error('Cancel failed:', err);
          btn.disabled = false; btn.textContent = 'Cancel';
          toast('Failed to cancel — please try again', 'error');
        }
      });
    });

    // Cancel all slots in a group (My Bookings section)
    el.querySelectorAll('.cb-cancel-group-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const groupId    = btn.dataset.groupId;
        const groupSlots = DB.getBookings().filter(b => b.groupId === groupId && (b.status === 'pending' || b.status === 'confirmed'));
        if (groupSlots.length > 0 && !bookingCancellationAllowed(groupSlots[0])) {
          toast('Cancellations are not permitted within 4 hours of the booking time or after the event has taken place.', 'error');
          return;
        }
        if (!confirm(`Cancel all ${groupSlots.length} slot(s) in this group booking?`)) return;
        btn.disabled = true; btn.textContent = 'Cancelling…';
        try {
          for (const b of groupSlots) { await DB.rejectBooking(b.id, 'cancelled'); }
          if (groupSlots.length > 0) {
            firebase.functions().httpsCallable('notifyUserCancellation')({ bookingId: groupSlots[0].id, groupId }).catch(() => {});
          }
          render();
          toast(`${groupSlots.length} booking(s) cancelled`);
        } catch (err) {
          console.error('Cancel group failed:', err);
          btn.disabled = false; btn.textContent = 'Cancel All';
          toast('Failed to cancel — please try again', 'error');
        }
      });
    });

    document.getElementById('cbVenue').addEventListener('change', e => {
      _selectedVenueId = e.target.value;
      _cart = [];
      render();
    });
    document.getElementById('cbDate').addEventListener('change', e => {
      _selectedDate = e.target.value;
      render();
    });
    document.getElementById('cbClearCart')?.addEventListener('click', () => {
      _cart = [];
      render();
    });
    el.querySelectorAll('.cb-cart-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        _cart.splice(parseInt(btn.dataset.idx), 1);
        render();
      });
    });
    el.querySelectorAll('.cb-avail-cell[data-ci]').forEach(cell => {
      cell.addEventListener('click', () => {
        _toggleCart(parseInt(cell.dataset.ci), _selectedDate, cell.dataset.slot);
        render();
      });
    });
    document.getElementById('cbSubmitBtn').addEventListener('click', _submit);
  }

  async function _submit() {
    const btn             = document.getElementById('cbSubmitBtn');
    const errEl           = document.getElementById('cbError');
    const booker          = document.getElementById('cbBooker').value.trim();
    const bookingType     = document.getElementById('cbType').value;
    const details         = document.getElementById('cbReason').value.trim();
    const onBehalfName    = document.getElementById('cbOnBehalfName').value.trim();
    const onBehalfContact = document.getElementById('cbOnBehalfContact').value.trim();
    const notes           = document.getElementById('cbNotes').value.trim();
    const reason          = bookingType + (details ? ': ' + details : '');

    errEl.textContent = '';
    if (_cart.length === 0) { errEl.textContent = 'Please select at least one slot.'; return; }
    if (!bookingType)        { errEl.textContent = 'Please select a booking type.'; return; }

    const unavail = _cart.filter(x => !_slotAvailable(_selectedVenueId, x.courtIndex, x.date, x.slot));
    if (unavail.length > 0) {
      errEl.textContent = `${unavail.length} selected slot(s) are no longer available. Please review your selection.`;
      render();
      return;
    }

    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      const user    = Auth.getUser();
      const profile = Auth.getProfile();
      const venue   = DB.getVenues().find(v => v.id === _selectedVenueId);
      const cartSnap = [..._cart];
      const groupId  = cartSnap.length > 1
        ? (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))
        : null;

      const bookingIds = [];
      const failed     = [];

      for (const item of cartSnap) {
        const result = DB.addBooking({
          venueId:         _selectedVenueId,
          courtIndex:      item.courtIndex,
          date:            item.date,
          timeSlot:        item.slot,
          type:            bookingType.toLowerCase() || 'booking',
          reason,
          label:           reason,
          bookerName:      booker || (profile ? (profile.displayName || profile.email) : ''),
          onBehalfName:    onBehalfName    || null,
          onBehalfContact: onBehalfContact || null,
          notes:           notes           || null,
          status:          'pending',
          groupId:         groupId || null,
          groupSize:       groupId ? cartSnap.length : null,
          requestedBy:     user    ? user.uid                               : null,
          requestedByName: profile ? (profile.displayName || profile.email) : null,
          requestedAt:     new Date().toISOString(),
        });
        if (result) bookingIds.push(result.id);
        else failed.push(item);
      }

      if (bookingIds.length === 0) {
        errEl.textContent = 'All selected slots were just booked. Please choose different slots.';
        btn.disabled = false;
        btn.textContent = cartSnap.length > 1 ? `Submit ${cartSnap.length} Booking Requests` : 'Submit Booking Request';
        render();
        return;
      }

      DB.writeAudit('booking_requested', 'booking',
        `Requested ${bookingIds.length} slot(s): ${reason} at ${venue ? venue.name : _selectedVenueId}`,
        null, reason);

      const failNote = failed.length > 0 ? ` (${failed.length} slot(s) were already taken and skipped)` : '';
      const msg = bookingIds.length === 1
        ? `Booking request submitted — awaiting approval ✓${failNote}`
        : `${bookingIds.length} booking requests submitted — awaiting approval ✓${failNote}`;
      toast(msg, 'success');

      try {
        await firebase.functions().httpsCallable('notifyBookingRequest')(
          groupId ? { groupId } : { bookingId: bookingIds[0] }
        );
      } catch (e) { /* non-critical */ }

      _cart = [];
      document.getElementById('cbType').value           = '';
      document.getElementById('cbReason').value         = '';
      document.getElementById('cbOnBehalfName').value   = '';
      document.getElementById('cbOnBehalfContact').value = '';
      document.getElementById('cbNotes').value          = '';
      render();
    } catch (err) {
      console.error('[CourtBooking] submit failed:', err);
      errEl.textContent = 'Failed to submit request — ' + (err.message || err);
      btn.disabled = false;
      btn.textContent = _cart.length > 1 ? `Submit ${_cart.length} Booking Requests` : 'Submit Booking Request';
    }
  }

  function init()    { render(); }
  function refresh() {
    const section = document.getElementById('view-courtbooking');
    if (section && !section.classList.contains('hidden')) render();
  }

  return { init, refresh, render, openWith };
})();
