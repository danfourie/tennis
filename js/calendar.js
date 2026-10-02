/**
 * calendar.js — Weekly court availability calendar (view only for non-organizers)
 *
 * Role-aware behaviour:
 *   Visitor             → guest screen (login/register prompt)
 *   Logged-in user      → read-only view; books via Court Booking view
 *   Venue Organiser     → direct booking at their own venue; approve/reject
 *   Master / Admin      → same as organiser at any venue
 *
 * Slots: morning (07:00–14:00) and afternoon (14:00–18:00).
 */

const Calendar = (() => {
  let currentWeekStart   = weekStart(new Date());
  let currentVenueFilter = 'all';

  // ── Guest booking state (persists across form re-renders) ────
  let _gklCart      = [];   // [{courtIndex, date, slot}]
  let _gklDate      = '';   // date currently shown in avail grid
  let _gklAvailData = null; // {courts, booked:[{courtIndex,timeSlot,status}], closed:[...]}

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

  /** True when any logged-in user may request a booking at this venue (Groenkloof / open venues). */
  function _isOpenVenue(venueId) {
    const v = DB.getVenues().find(v => v.id === venueId);
    if (!v) return false;
    if (v.openBookings) return true; // explicit flag
    return (v.name || '').toLowerCase().includes('groenkloof');
  }

  /**
   * Return { fixture, league } if a league fixture occupies this slot.
   * A match blocks COURTS_PER_MATCH courts (starting from the fixture's
   * base courtIndex) for MATCH_MINS (3 hours) from matchTime.
   */
  /**
   * Pre-compute court assignments for every fixture based on how many
   * fixtures actually share the same venue+date (rather than trusting the
   * stored courtIndex / courtsBooked which may be stale for old fixtures).
   *
   * Returns Map<fixtureId, { courtIndex, courtsBooked }>
   *
   * Algorithm:
   *   Group fixtures by venue+date → sort each group by stored courtIndex
   *   (stable ordering) → divide venue courts evenly (max 3 each).
   *
   * Examples:
   *   4-court venue, 2 fixtures → cb=2: fixture0 courts 0-1, fixture1 courts 2-3
   *   6-court venue, 2 fixtures → cb=3: 0-2 and 3-5
   *   6-court venue, 3 fixtures → cb=2: 0-1, 2-3, 4-5
   *   1-court venue             → cb=1: flagged as clash elsewhere
   */
  function _buildFixtureCourtMap() {
    const map    = new Map(); // fixtureId → {courtIndex, courtsBooked}
    const groups = {};        // 'venueId|date' → [{f, league}]

    for (const league of DB.getLeagues()) {
      for (const f of (league.fixtures || [])) {
        if (!f.venueId || !f.date || !f.id) continue;
        const key = `${f.venueId}|${f.date}`;
        (groups[key] || (groups[key] = [])).push({ f, league });
      }
    }

    for (const entries of Object.values(groups)) {
      const venueId = entries[0].f.venueId;
      const venue   = DB.getVenues().find(v => v.id === venueId);
      const vc      = venue ? (venue.courts || 0) : 0;
      const n       = entries.length;
      const cb      = Math.min(3, Math.max(1, Math.floor(vc / n)));
      // Stable ordering: sort by stored courtIndex so fixture positions
      // remain consistent whether read from Firestore cache or memory.
      entries.sort((a, b) => (a.f.courtIndex || 0) - (b.f.courtIndex || 0));
      entries.forEach(({ f }, i) => {
        map.set(f.id, { courtIndex: i * cb, courtsBooked: cb });
      });
    }
    return map;
  }

  // Cache rebuilt once per render() call
  let _fixtureCourtMap = new Map();

  function _getLeagueFixtureForSlot(venueId, courtIndex, dateStr, slot) {
    // Map slot to time range in minutes
    const slotStartMins = slot === 'morning' ? 7 * 60 : slot === 'afternoon' ? 14 * 60 : _timeToMins(slot);
    const slotEndMins   = slot === 'morning' ? 14 * 60 : slot === 'afternoon' ? 18 * 60 : slotStartMins + 60;

    for (const league of DB.getLeagues()) {
      for (const f of (league.fixtures || [])) {
        if (!f.venueId || f.venueId !== venueId) continue;
        if (f.date !== dateStr) continue;

        const cached       = _fixtureCourtMap.get(f.id);
        const courtsBooked = cached ? cached.courtsBooked : (f.courtsBooked || 3);
        const baseCourt    = cached ? cached.courtIndex   : (f.courtIndex != null ? parseInt(f.courtIndex) : 0);
        const matchMins    = courtsBooked >= 3 ? 180 : 240;

        if (courtIndex < baseCourt || courtIndex >= baseCourt + courtsBooked) continue;

        const fixtureMins = _timeToMins(f.timeSlot || '14:00');
        const fixtureEnd  = fixtureMins + matchMins;

        // Overlap: fixture starts before slot ends AND fixture ends after slot starts
        if (fixtureMins < slotEndMins && fixtureEnd > slotStartMins) {
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
    const datePicker = document.getElementById('calDatePicker');
    if (datePicker) {
      datePicker.addEventListener('change', e => {
        if (!e.target.value) return;
        currentWeekStart = weekStart(new Date(e.target.value + 'T00:00:00'));
        render();
      });
    }
    populateVenueFilter();
    render();
  }

  function populateVenueFilter() {
    const sel    = document.getElementById('venueFilter');
    const venues = DB.getVenues(); // already sorted alphabetically by getter
    while (sel.options.length > 1) sel.remove(1);
    venues.forEach(v => sel.add(new Option(v.name, v.id)));
    // Default to the user's home venue on first load (only when still on 'all').
    // Users without a school default to Groenkloof; non-logged-in users also get Groenkloof.
    if (currentVenueFilter === 'all') {
      const profile = Auth.getProfile();
      if (profile && profile.schoolId) {
        const school = DB.getSchools().find(s => s.id === profile.schoolId);
        if (school && school.venueId) {
          currentVenueFilter = school.venueId;
        }
      }
      // Fall back to Groenkloof when no school venue was found
      if (currentVenueFilter === 'all') {
        const gkl = venues.find(v => (v.name || '').toLowerCase().includes('groenkloof'));
        if (gkl) currentVenueFilter = gkl.id;
      }
    }
    sel.value = currentVenueFilter;
  }

  function refresh() {
    populateVenueFilter();
    render();
  }

  // ── Guest screen ─────────────────────────────────────────────
  function _renderGuestScreen() {
    const calHdr = document.querySelector('#view-calendar .view-header');
    if (calHdr) calHdr.style.display = 'none';
    const container  = document.getElementById('calendarContainer');
    const today      = new Date().toISOString().slice(0, 10);
    const gklVenue   = DB.getVenues().find(v =>
      (v.name || '').toLowerCase().includes('groenkloof') || v.openBookings === true
    );
    const gklVenueId = gklVenue ? gklVenue.id : null;
    const gklCourts  = gklVenue
      ? (Array.isArray(gklVenue.courts) && gklVenue.courts.length
          ? gklVenue.courts
          : Array.from({ length: gklVenue.courtCount || 1 }, (_, i) => ({ name: `Court ${i + 1}` })))
      : [];
    const gklCourtOpts = gklCourts
      .map((c, i) => `<option value="${i}">${esc(c.name || `Court ${i + 1}`)}</option>`)
      .join('');

    container.innerHTML = `
      <div class="guest-screen">
        <div style="font-size:3rem;margin-bottom:.75rem">🎾</div>
        <h3 style="margin:0 0 .5rem;color:var(--primary-dark)">Court Campus</h3>
        <p class="text-muted" style="margin:0 0 1.5rem;max-width:380px">
          Log in to view court availability and league fixtures.
        </p>
        <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary"  id="guestLoginBtn">Login</button>
          <button class="btn btn-outline"  id="guestRegisterBtn">Register</button>
          <button class="btn btn-secondary" id="guestContactBtn">Contact Admin</button>
        </div>
        ${gklVenueId ? `
        <div style="margin-top:1rem">
          <button class="btn btn-primary" id="guestGroenkloofBtn" style="min-width:230px">
            📅 Book at Groenkloof
          </button>
        </div>` : ''}

        <!-- ── Contact Admin form ───────────────────────── -->
        <div id="guestContactForm" class="guest-contact-form hidden">
          <div class="form-group">
            <label>Your name <span style="color:var(--danger,#dc2626)">*</span></label>
            <input type="text" id="guestContactName" placeholder="Full name" autocomplete="name">
          </div>
          <div class="form-group">
            <label>Email address <span class="text-muted" style="font-weight:400">(optional)</span></label>
            <input type="email" id="guestContactEmail" placeholder="so we can reply to you" autocomplete="email">
          </div>
          <div class="form-group">
            <label>Message <span style="color:var(--danger,#dc2626)">*</span></label>
            <textarea id="guestContactMessage" rows="4" placeholder="How can we help?"></textarea>
          </div>
          <p id="guestContactError" class="form-error" style="display:none"></p>
          <div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:.5rem">
            <button class="btn btn-outline btn-sm" id="guestContactCancelBtn">Cancel</button>
            <button class="btn btn-primary" id="guestContactSubmitBtn">Send Message</button>
          </div>
        </div>

        <!-- ── Groenkloof Booking form ──────────────────── -->
        ${gklVenueId ? `
        <div id="guestGroenkloofForm" class="guest-contact-form hidden" style="max-width:480px;text-align:left">
          <h4 style="margin:0 0 .75rem;color:var(--primary-dark)">📅 Groenkloof Court Booking</h4>
          <p style="font-size:.82rem;background:var(--info-bg,#eff6ff);border:1px solid var(--info-border,#bfdbfe);border-radius:var(--radius);padding:.55rem .8rem;margin:0 0 .9rem">
            <strong>New to Court Campus?</strong> We'll create your account automatically.
            Already registered? Your password will sign you in and the booking will be placed under your name.
          </p>
          <div class="form-group">
            <label>Full Name <span style="color:var(--danger,#dc2626)">*</span></label>
            <input type="text" id="gklName" placeholder="Your full name" autocomplete="name">
          </div>
          <div class="form-group">
            <label>Email Address <span style="color:var(--danger,#dc2626)">*</span></label>
            <input type="email" id="gklEmail" placeholder="your@email.com" autocomplete="email">
          </div>
          <div class="form-group">
            <label>Password
              <span class="text-muted" style="font-weight:400">&nbsp;— only required for new accounts (min. 6 characters)</span>
            </label>
            <input type="password" id="gklPassword" placeholder="Leave blank if already registered" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label>Contact Number <span style="color:var(--danger,#dc2626)">*</span></label>
            <input type="tel" id="gklPhone" placeholder="e.g. 082 000 0000" autocomplete="tel">
          </div>
          <hr style="margin:.5rem 0 .9rem;border:none;border-top:1px solid var(--border)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.5rem">
            <strong style="font-size:.88rem">Select Slot(s)</strong>
          </div>
          <div class="form-group">
            <label>Date <span style="color:var(--danger,#dc2626)">*</span></label>
            <input type="date" id="gklDate" min="${today}" value="${_gklDate || today}">
          </div>
          <!-- Availability grid — populated by JS after CF call -->
          <div id="gklAvailGrid" style="margin-bottom:.5rem">
            <p style="font-size:.83rem;color:var(--neutral);font-style:italic;padding:.25rem 0">
              Select a date above to check court availability.
            </p>
          </div>
          <!-- Cart: selected slots -->
          <div id="gklCartChips" style="margin-bottom:.75rem"></div>
          <hr style="margin:.5rem 0 .9rem;border:none;border-top:1px solid var(--border)">
          <div class="form-group">
            <label>Booking Type <span style="color:var(--danger,#dc2626)">*</span></label>
            <select id="gklType">
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
            <input type="text" id="gklDetails" placeholder="e.g. team name, opponent…">
          </div>
          <p id="gklError" class="form-error" style="display:none"></p>
          <div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:.5rem">
            <button class="btn btn-outline btn-sm" id="gklCancelBtn">Cancel</button>
            <button class="btn btn-primary" id="gklSubmitBtn">Request Booking</button>
          </div>
        </div>` : ''}
      </div>`;

    // ── Helper: toggle between forms ──────────────────────────
    function _showForm(showId, hideId) {
      const hide = document.getElementById(hideId);
      if (hide) hide.classList.add('hidden');
      const show = document.getElementById(showId);
      if (!show) return;
      const wasHidden = show.classList.contains('hidden');
      show.classList.toggle('hidden');
      if (wasHidden) { const f = show.querySelector('input,textarea,select'); if (f) f.focus(); }
    }

    // ── Login / Register ──────────────────────────────────────
    document.getElementById('guestLoginBtn').onclick = () => {
      ['loginEmail','loginPassword'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      document.getElementById('loginError').textContent = '';
      Modal.open('loginModal');
    };
    document.getElementById('guestRegisterBtn').onclick = () => {
      const sel = document.getElementById('regSchool');
      if (sel) sel.innerHTML = '<option value="">-- No school --</option>' +
        DB.getSchools().map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      Modal.open('registerModal');
    };

    // ── Contact Admin ─────────────────────────────────────────
    document.getElementById('guestContactBtn').onclick       = () => _showForm('guestContactForm', 'guestGroenkloofForm');
    document.getElementById('guestContactCancelBtn').onclick = () => document.getElementById('guestContactForm').classList.add('hidden');
    document.getElementById('guestContactSubmitBtn').onclick = async () => {
      const name    = (document.getElementById('guestContactName').value    || '').trim();
      const email   = (document.getElementById('guestContactEmail').value   || '').trim();
      const message = (document.getElementById('guestContactMessage').value || '').trim();
      const errEl   = document.getElementById('guestContactError');
      const btn     = document.getElementById('guestContactSubmitBtn');
      errEl.style.display = 'none';
      if (!name)    { errEl.textContent = 'Please enter your name';    errEl.style.display = 'block'; return; }
      if (!message) { errEl.textContent = 'Please enter a message';    errEl.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await firebase.functions().httpsCallable('contactAdmin')({ name, email, message });
        document.getElementById('guestContactForm').innerHTML = `
          <p style="text-align:center;color:var(--success,#16a34a);font-weight:600;padding:.75rem 0">
            ✓ Message sent — an admin will be in touch.
          </p>`;
      } catch (err) {
        errEl.textContent = 'Could not send message. Please try again later.';
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Send Message';
      }
    };

    // ── Groenkloof Booking ────────────────────────────────────
    if (!gklVenueId) return;

    document.getElementById('guestGroenkloofBtn').onclick = () => {
      _showForm('guestGroenkloofForm', 'guestContactForm');
      // If we have a date already, load availability immediately
      const dateEl = document.getElementById('gklDate');
      if (dateEl && dateEl.value) _gklLoadAvail(gklVenueId);
    };
    document.getElementById('gklCancelBtn').onclick = () => {
      document.getElementById('guestGroenkloofForm').classList.add('hidden');
    };

    // Slot label helper
    function _slotLabel(slot) {
      if (slot === 'morning')   return 'Morning (07:00–14:00)';
      if (slot === 'afternoon') return 'Afternoon (14:00–18:00)';
      return slot;
    }

    // Render cart chips beneath the avail grid
    function _gklRenderCartChips() {
      const el = document.getElementById('gklCartChips');
      if (!el) return;
      if (_gklCart.length === 0) { el.innerHTML = ''; return; }
      const venue = DB.getVenues().find(v => v.id === gklVenueId);
      const courts = (venue && venue.courts) || [];
      el.innerHTML = `
        <p style="font-size:.77rem;color:var(--neutral);margin:0 0 .3rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">
          Selected (${_gklCart.length})
        </p>
        <div class="cb-cart-chips">
          ${_gklCart.map((item, i) => {
            const cName = courts[item.courtIndex] ? courts[item.courtIndex].name : `Court ${item.courtIndex + 1}`;
            return `<span class="cb-cart-chip" style="display:inline-flex;align-items:center;gap:.3rem;background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:.22rem .65rem;font-size:.78rem;font-weight:600;margin:.15rem">
              ${esc(cName)} · ${esc(item.date)} · ${esc(_slotLabel(item.slot))}
              <button type="button" data-gkl-remove="${i}"
                style="background:none;border:none;cursor:pointer;font-size:.85rem;color:#1d4ed8;line-height:1;padding:0;margin-left:.1rem"
                aria-label="Remove">✕</button>
            </span>`;
          }).join('')}
        </div>`;
      el.querySelectorAll('[data-gkl-remove]').forEach(btn => {
        btn.onclick = () => {
          _gklCart.splice(parseInt(btn.dataset.gklRemove, 10), 1);
          _gklRenderCartChips();
          _gklRenderAvailGrid(); // refresh cell states
        };
      });
    }

    // Render the availability grid for _gklDate
    function _gklRenderAvailGrid() {
      const gridEl = document.getElementById('gklAvailGrid');
      if (!gridEl) return;
      if (!_gklAvailData) {
        gridEl.innerHTML = `<p style="font-size:.83rem;color:var(--neutral);font-style:italic;padding:.25rem 0">Select a date above to check court availability.</p>`;
        return;
      }
      const { courts, booked, closed } = _gklAvailData;
      const slots = ['morning', 'afternoon'];
      const isBooked = (ci, slot) => booked.some(b => b.courtIndex === ci && b.timeSlot === slot);
      const isClosed = (ci, slot) => closed.some(c => c.courtIndex === ci && c.timeSlot === slot);
      const inCart   = (ci, slot) => _gklCart.some(c => c.courtIndex === ci && c.slot === slot && c.date === _gklDate);

      let html = `<div style="overflow-x:auto;margin-bottom:.25rem">
        <table style="width:100%;border-collapse:collapse;font-size:.8rem">
          <thead>
            <tr>
              <th style="padding:.3rem .5rem;text-align:left;color:var(--neutral);font-weight:600">Court</th>
              ${slots.map(s => `<th style="padding:.3rem .5rem;text-align:center;color:var(--neutral);font-weight:600">${_slotLabel(s)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>`;
      courts.forEach((court, ci) => {
        html += `<tr>
          <td style="padding:.3rem .5rem;font-weight:600;white-space:nowrap">${esc(court.name || `Court ${ci+1}`)}</td>`;
        slots.forEach(slot => {
          const booked_ = isBooked(ci, slot);
          const closed_ = isClosed(ci, slot);
          const inCart_ = inCart(ci, slot);
          let bg, color, cursor, label, clickable;
          if (booked_ || closed_) {
            bg = '#f1f5f9'; color = '#94a3b8'; cursor = 'default';
            label = booked_ ? 'Booked' : 'Closed'; clickable = false;
          } else if (inCart_) {
            bg = '#2563eb'; color = '#fff'; cursor = 'pointer';
            label = '✓ Added'; clickable = true;
          } else {
            bg = '#dcfce7'; color = '#166534'; cursor = 'pointer';
            label = 'Available'; clickable = true;
          }
          const dataAttrs = clickable ? `data-gkl-ci="${ci}" data-gkl-slot="${slot}"` : '';
          html += `<td style="padding:.3rem .4rem;text-align:center">
            <span ${dataAttrs} style="display:inline-block;padding:.3rem .6rem;border-radius:5px;background:${bg};color:${color};cursor:${cursor};font-size:.77rem;font-weight:600;min-width:70px;user-select:none">
              ${label}
            </span>
          </td>`;
        });
        html += `</tr>`;
      });
      html += `</tbody></table></div>
        <p style="font-size:.75rem;color:var(--neutral);margin:.2rem 0 0">Click an available slot to add it to your request.</p>`;
      gridEl.innerHTML = html;

      // Click handlers on available cells
      gridEl.querySelectorAll('[data-gkl-ci]').forEach(cell => {
        cell.onclick = () => {
          const ci   = parseInt(cell.dataset.gklCi, 10);
          const slot = cell.dataset.gklSlot;
          const idx  = _gklCart.findIndex(c => c.courtIndex === ci && c.slot === slot && c.date === _gklDate);
          if (idx >= 0) {
            _gklCart.splice(idx, 1); // deselect
          } else {
            _gklCart.push({ courtIndex: ci, date: _gklDate, slot });
          }
          _gklRenderAvailGrid();
          _gklRenderCartChips();
        };
      });
    }

    // Fetch availability from the public CF, then render
    async function _gklLoadAvail(venueId) {
      const gridEl = document.getElementById('gklAvailGrid');
      if (!gridEl) return;
      const date = document.getElementById('gklDate').value;
      if (!date) return;
      _gklDate      = date;
      _gklAvailData = null;
      gridEl.innerHTML = `<p style="font-size:.83rem;color:var(--neutral);font-style:italic;padding:.25rem 0">Checking availability…</p>`;
      try {
        const fn  = firebase.functions().httpsCallable('getGroenkloofAvailability');
        const res = await fn({ venueId, date });
        _gklAvailData = res.data;
        _gklRenderAvailGrid();
      } catch (e) {
        gridEl.innerHTML = `<p style="font-size:.83rem;color:var(--danger,#dc2626);padding:.25rem 0">Could not load availability. Please try again.</p>`;
      }
    }

    // Date picker triggers availability load
    document.getElementById('gklDate').addEventListener('change', () => {
      // Clear cart slots for old date that differ from new date
      const newDate = document.getElementById('gklDate').value;
      _gklCart = _gklCart.filter(c => c.date === newDate);
      _gklRenderCartChips();
      _gklLoadAvail(gklVenueId);
    });

    document.getElementById('gklSubmitBtn').onclick = async () => {
      const name        = (document.getElementById('gklName').value     || '').trim();
      const email       = (document.getElementById('gklEmail').value    || '').trim();
      const password    = (document.getElementById('gklPassword').value || '');
      const phone       = (document.getElementById('gklPhone').value    || '').trim();
      const bookingType = document.getElementById('gklType').value;
      const details     = (document.getElementById('gklDetails').value  || '').trim();
      const errEl       = document.getElementById('gklError');
      const btn         = document.getElementById('gklSubmitBtn');

      errEl.style.display = 'none';
      if (!name)             { errEl.textContent = 'Full name is required.';          errEl.style.display = 'block'; return; }
      if (!email)            { errEl.textContent = 'Email address is required.';       errEl.style.display = 'block'; return; }
      if (!phone)            { errEl.textContent = 'Contact number is required.';      errEl.style.display = 'block'; return; }
      if (_gklCart.length === 0) { errEl.textContent = 'Please select at least one slot from the availability grid.'; errEl.style.display = 'block'; return; }
      if (!bookingType)      { errEl.textContent = 'Please select a booking type.';    errEl.style.display = 'block'; return; }

      btn.disabled = true; btn.textContent = 'Processing…';

      try {
        const fn  = firebase.functions().httpsCallable('bookGroenkloofCourt');
        const res = await fn({
          name, email, phone, password,
          venueId: gklVenueId,
          slots:   _gklCart.map(c => ({ courtIndex: c.courtIndex, date: c.date, timeSlot: c.slot })),
          bookingType,
          details,
        });

        if (res.data && res.data.isNewUser && password) {
          try {
            await firebase.auth().signInWithEmailAndPassword(email, password);
          } catch (_) {
            if (res.data.customToken) {
              try { await firebase.auth().signInWithCustomToken(res.data.customToken); } catch (_2) {}
            }
          }
        } else if (res.data && res.data.customToken) {
          try { await firebase.auth().signInWithCustomToken(res.data.customToken); } catch (_) {}
        }

        _gklCart      = [];
        _gklAvailData = null;
        toast('Booking requested ✓ — awaiting approval', 'success');

      } catch (err) {
        const msg = (err.details && err.details.message) || err.message || 'Something went wrong. Please try again.';
        errEl.textContent = msg;
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Request Booking';
      }
    };
  }

  // ── Main render ─────────────────────────────────────────────
  function render() {
    if (!Auth.isLoggedIn()) { _renderGuestScreen(); return; }

    const calHdr = document.querySelector('#view-calendar .view-header');
    if (calHdr) calHdr.style.display = '';

    // Rebuild fixture→court mapping so allocations always reflect actual
    // sharing at each venue+date (fixes stale stored courtIndex values too).
    _fixtureCourtMap = _buildFixtureCourtMap();

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

    const slots = getTimeSlots(); // ['morning', 'afternoon']

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
              html += _renderSlot(venue, ci, dStr, slot, courtClosed);
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

  function _renderSlot(venue, ci, dStr, slot, courtFullyClosed) {
    if (courtFullyClosed && !_hasTimeSpecificClosure(venue.id, ci, dStr)) return '';

    const slotName  = getSlotDisplayName(slot); // 'Morning' or 'Afternoon'
    const slotLabel = getSlotLabel(slot);        // '07:00 – 14:00'

    const slotClosed = isCourtClosed(venue.id, ci, dStr, slot);
    if (slotClosed) {
      return `<span class="slot-chip closed" title="Closed — ${slotLabel}">${slotName}</span>`;
    }

    // ── Existing booking ──────────────────────────────────────
    const booking = getSlotBooking(venue.id, ci, dStr, slot);
    if (booking) {
      const isPending = booking.status === 'pending';
      const type      = booking.type || 'booking';
      const cls       = isPending ? 'pending-request' : type === 'league' ? 'league' : type === 'tournament' ? 'tournament' : 'booked';
      const rawLabel  = booking.reason || booking.label || booking.schoolName || (isPending ? 'Pending' : 'Booked');
      const badge     = isPending ? ' ⏳' : '';
      return `<button class="slot-chip ${cls}" data-slot="1" data-venue="${venue.id}" data-court="${ci}" data-date="${dStr}" data-slot-time="${slot}" title="${esc(rawLabel)}${badge} — ${slotName}">${esc(rawLabel.substring(0,22))}${badge}<span class="slot-time">${slotName}</span></button>`;
    }

    // ── League fixture ────────────────────────────────────────
    const leagueSlot = _getLeagueFixtureForSlot(venue.id, ci, dStr, slot);
    if (leagueSlot) {
      const { fixture: f, league } = leagueSlot;
      const tooltip = `${f.homeSchoolName} vs ${f.awaySchoolName} @ ${f.timeSlot || '14:00'} — ${league.name}`;
      return `<span class="slot-chip league" title="${esc(tooltip)}">${slotName}<span class="slot-time">${f.timeSlot || '14:00'}</span></span>`;
    }

    // ── Available ─────────────────────────────────────────────
    const isOrganizer = _isVenueOrganizer(venue.id);
    if (Auth.isAdmin() || isOrganizer) {
      // Organizers/admins: click to book directly from calendar
      return `<button class="slot-chip available admin-can-book" data-slot="1" data-venue="${venue.id}" data-court="${ci}" data-date="${dStr}" data-slot-time="${slot}" title="Book ${slotName}">${slotName}<span class="slot-time">${slotLabel}</span></button>`;
    }
    // Regular users: slot is informational; they book via Court Booking view
    return `<span class="slot-chip available" title="Available — use Court Booking">${slotName}<span class="slot-time">${slotLabel}</span></span>`;
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
            <div class="booking-info-item"><span class="label">Slot</span><span class="value">${getSlotDisplayName(timeStr)} (${getSlotLabel(timeStr)})</span></div>
            <div class="booking-info-item"><span class="label">Court</span><span class="value">Court ${courtIndex + 1}</span></div>
            <div class="booking-info-item"><span class="label">Status</span><span class="value">
              <span class="badge badge-${isPending ? 'amber' : booking.type === 'league' ? 'blue' : booking.type === 'tournament' ? 'amber' : 'green'}">
                ${isPending ? 'Pending' : (booking.type || 'booking')}
              </span>
            </span></div>
          </div>
          <div class="booking-info-row">
            ${booking.reason ? `<div class="booking-info-item"><span class="label">Reason</span><span class="value">${esc(booking.reason)}</span></div>` : ''}
            <div class="booking-info-item"><span class="label">Booker</span><span class="value">${esc(booking.bookerName || booking.requestedByName || booking.label || '—')}</span></div>
            ${booking.onBehalfName ? `<div class="booking-info-item"><span class="label">On behalf of</span><span class="value">${esc(booking.onBehalfName)}${booking.onBehalfContact ? ` · ${esc(booking.onBehalfContact)}` : ''}</span></div>` : ''}
            ${school ? `<div class="booking-info-item"><span class="label">School</span><span class="value">${esc(school.name)}</span></div>` : ''}
            ${booking.notes ? `<div class="booking-info-item"><span class="label">Notes</span><span class="value">${esc(booking.notes)}</span></div>` : ''}
          </div>
        </div>`;

      if (canManage && isPending) {
        // Admin / venue organiser: approve or reject
        footer.innerHTML = `
          <button class="btn btn-secondary" data-modal="bookingModal">Close</button>
          <button class="btn btn-danger"    id="rejectBookingBtn">Reject</button>
          <button class="btn btn-primary"   id="approveBookingBtn">Approve ✓</button>`;
        document.getElementById('approveBookingBtn').onclick = async () => {
          const aBtn = document.getElementById('approveBookingBtn');
          if (aBtn) { aBtn.disabled = true; aBtn.textContent = 'Approving…'; }
          DB.approveBooking(booking.id);
          DB.writeAudit('booking_approved', 'booking',
            `Approved request by ${esc(booking.requestedByName || 'user')}: ${esc(booking.reason || booking.label || '')} on ${dateStr}`,
            booking.id, booking.reason || booking.label || '');
          if (booking.requestedBy && typeof NotificationService !== 'undefined') {
            NotificationService.send({
              type:          'booking_approved',
              title:         'Booking Request Approved ✅',
              body:          `Your request to book ${esc(booking.label || booking.reason || venue ? venue.name : '')} on ${formatDate(dateStr)} has been approved.`,
              recipientUids: [booking.requestedBy],
            });
          }
          Modal.close('bookingModal');
          render();
          toast('Booking approved ✓', 'success');
          firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: booking.id, action: 'approved' }).catch(() => {});
        };
        document.getElementById('rejectBookingBtn').onclick = async () => {
          const btn = document.getElementById('rejectBookingBtn');
          if (btn) { btn.disabled = true; btn.textContent = 'Rejecting…'; }
          try {
            await firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: booking.id, action: 'rejected' }).catch(() => {});
            if (booking.requestedBy && typeof NotificationService !== 'undefined') {
              NotificationService.send({
                type:          'booking_rejected',
                title:         'Booking Request Rejected',
                body:          `Your request to book ${esc(booking.label || booking.reason || '')} on ${formatDate(dateStr)} has been declined.`,
                recipientUids: [booking.requestedBy],
              });
            }
            await DB.rejectBooking(booking.id, 'rejected');
            DB.writeAudit('booking_rejected', 'booking',
              `Rejected request by ${esc(booking.requestedByName || 'user')}: ${esc(booking.reason || booking.label || '')} on ${dateStr}`,
              booking.id, booking.reason || booking.label || '');
            Modal.close('bookingModal');
            render();
            toast('Request rejected');
          } catch (err) {
            console.error('Reject booking failed:', err);
            if (btn) { btn.disabled = false; btn.textContent = 'Reject'; }
            toast('Failed to reject booking — please try again', 'error');
            render();
          }
        };
      } else if (canManage) {
        // Admin / venue organiser: cancel confirmed booking (soft-delete)
        footer.innerHTML = `
          <button class="btn btn-secondary" data-modal="bookingModal">Close</button>
          <button class="btn btn-danger" id="deleteBookingBtn">Cancel Booking</button>`;
        document.getElementById('deleteBookingBtn').onclick = async () => {
          const btn = document.getElementById('deleteBookingBtn');
          if (!bookingCancellationAllowed(booking)) {
            toast('Cancellations are not permitted within 4 hours of the booking time or after the event has taken place.', 'error');
            return;
          }
          if (!confirm(`Cancel this booking?\n\n"${booking.label || 'Booking'}" on ${dateStr}\n\nThe requester will be notified.`)) return;
          if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
          try {
            firebase.functions().httpsCallable('notifyBookingStatus')({ bookingId: booking.id, action: 'cancelled' }).catch(() => {});
            if (booking.requestedBy && typeof NotificationService !== 'undefined') {
              NotificationService.send({
                type: 'booking_cancelled', title: 'Booking Cancelled',
                body: `Your confirmed booking for ${esc(booking.label || '')} on ${formatDate(dateStr)} has been cancelled.`,
                recipientUids: [booking.requestedBy],
              });
            }
            await DB.rejectBooking(booking.id, 'cancelled');
            DB.writeAudit('booking_cancelled', 'booking',
              `Booking cancelled: ${esc(booking.label || '')} on ${dateStr}`,
              booking.id, booking.label || '');
            Modal.close('bookingModal');
            render();
            toast('Booking cancelled', 'success');
          } catch (err) {
            console.error('Cancel booking failed:', err);
            if (btn) { btn.disabled = false; btn.textContent = 'Cancel Booking'; }
            toast('Failed to cancel booking — please try again', 'error');
            render();
          }
        };
      } else if (isOwnRequest) {
        // Owner: cancel own pending request (soft-delete)
        footer.innerHTML = `
          <button class="btn btn-secondary" data-modal="bookingModal">Close</button>
          <button class="btn btn-danger" id="cancelRequestBtn">Cancel My Request</button>`;
        document.getElementById('cancelRequestBtn').onclick = async () => {
          const btn = document.getElementById('cancelRequestBtn');
          if (!bookingCancellationAllowed(booking)) {
            toast('Cancellations are not permitted within 4 hours of the booking time or after the event has taken place.', 'error');
            return;
          }
          if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
          try {
            await DB.rejectBooking(booking.id, 'cancelled');
            firebase.functions().httpsCallable('notifyUserCancellation')({ bookingId: booking.id }).catch(() => {});
            DB.writeAudit('booking_cancelled', 'booking',
              `Request cancelled by requester: ${esc(booking.label || '')} on ${dateStr}`,
              booking.id, booking.label || '');
            Modal.close('bookingModal');
            render();
            toast('Request cancelled');
          } catch (err) {
            console.error('Cancel booking failed:', err);
            if (btn) { btn.disabled = false; btn.textContent = 'Cancel My Request'; }
            toast('Failed to cancel request — please try again', 'error');
            render();
          }
        };
      } else {
        footer.innerHTML = `<button class="btn btn-secondary" data-modal="bookingModal">Close</button>`;
      }

    } else if (Auth.isAdmin() || isOrganizer) {
      // ── Admin / Venue Organiser: submit pending booking request ────
      const _prof = Auth.getProfile();
      const _defaultBooker = _prof ? (_prof.displayName || _prof.email || '') : '';
      body.innerHTML = `
        <div class="form-stack">
          ${isOrganizer && !Auth.isAdmin() ? `<div class="form-hint organiser-hint">🏟 Booking as organiser of <strong>${esc(venue.name)}</strong></div>` : ''}
          <div class="booking-info-row">
            <div class="booking-info-item"><span class="label">Date</span><span class="value">${formatDate(dateStr)}</span></div>
            <div class="booking-info-item"><span class="label">Court</span><span class="value">Court ${courtIndex + 1}</span></div>
            <div class="booking-info-item"><span class="label">Slot</span><span class="value">${getSlotDisplayName(timeStr)} (${getSlotLabel(timeStr)})</span></div>
          </div>
          <div class="form-group">
            <label>Your Name <span class="text-muted">(booker)</span></label>
            <input type="text" id="newBookingBooker" value="${esc(_defaultBooker)}" placeholder="Your full name">
          </div>
          <div class="form-group">
            <label>Reason for Booking <span style="color:var(--danger)">*</span></label>
            <input type="text" id="newBookingReason" placeholder="e.g. Practice session, friendly match…">
          </div>
          <div class="form-group">
            <label>Booking Type</label>
            <select id="newBookingType">
              <option value="booking">General Booking</option>
              <option value="practice">Practice</option>
              <option value="coaching">Coaching</option>
              <option value="league">League Match</option>
              <option value="tournament">Tournament</option>
            </select>
          </div>
          <hr style="margin:.25rem 0;border:none;border-top:1px solid var(--border)">
          <p style="font-size:.8rem;color:var(--neutral);margin:0">Booking on behalf of someone else? (optional)</p>
          <div class="booking-info-row">
            <div class="form-group" style="margin:0">
              <label>Name</label>
              <input type="text" id="newBookingOnBehalfName" placeholder="Player / coach name">
            </div>
            <div class="form-group" style="margin:0">
              <label>Contact Number</label>
              <input type="tel" id="newBookingOnBehalfContact" placeholder="e.g. 082 000 0000">
            </div>
          </div>
          <div class="form-group">
            <label>Notes (optional)</label>
            <input type="text" id="newBookingNotes" placeholder="Additional info">
          </div>
        </div>`;

      footer.innerHTML = `
        <button class="btn btn-secondary" data-modal="bookingModal">Cancel</button>
        <button class="btn btn-primary"   id="saveBookingBtn">Submit Booking Request</button>`;

      document.getElementById('saveBookingBtn').onclick = async () => {
        const booker        = document.getElementById('newBookingBooker').value.trim();
        const reason        = document.getElementById('newBookingReason').value.trim();
        const type          = document.getElementById('newBookingType').value;
        const onBehalfName  = document.getElementById('newBookingOnBehalfName').value.trim();
        const onBehalfContact = document.getElementById('newBookingOnBehalfContact').value.trim();
        const notes         = document.getElementById('newBookingNotes').value.trim();
        if (!reason) { toast('Reason for booking is required', 'error'); return; }
        const _adminUser = Auth.getUser();
        const _adminProf = Auth.getProfile();
        const result = DB.addBooking({
          venueId, courtIndex, date: dateStr, timeSlot: timeStr,
          type,
          reason,
          label:              reason,
          bookerName:         booker,
          onBehalfName:       onBehalfName  || null,
          onBehalfContact:    onBehalfContact || null,
          notes:              notes || null,
          status:             'pending',
          requestedBy:        _adminUser ? _adminUser.uid : null,
          requestedByName:    _adminProf ? (_adminProf.displayName || _adminProf.email) : null,
          requestedAt:        new Date().toISOString(),
        });
        if (!result) { toast('This slot is already booked', 'error'); return; }
        DB.writeAudit('booking_requested', 'booking',
          `Requested: ${reason} on ${dateStr} (${getSlotDisplayName(timeStr)}) at ${venue.name} Court ${courtIndex + 1}`,
          null, reason);
        Modal.close('bookingModal');
        render();
        toast('Booking request submitted — awaiting approval ✓', 'success');
        // Notify venue organizers via Cloud Function (fire-and-forget)
        try {
          await firebase.functions().httpsCallable('notifyBookingRequest')({ bookingId: result.id });
        } catch (e) { /* non-critical */ }
      };

    } else if (Auth.isLoggedIn()) {
      // ── Logged-in user viewing an available/booked slot ──────
      // They book via the Court Booking view
      body.innerHTML = `
        <div style="text-align:center;padding:1.25rem .5rem">
          <p style="font-size:.95rem;margin-bottom:.75rem">
            <strong>${getSlotDisplayName(timeStr)}</strong> — ${getSlotLabel(timeStr)}<br>
            ${formatDate(dateStr)} · Court ${courtIndex + 1}
          </p>
          <p class="text-muted" style="font-size:.9rem">To request a booking, use the <strong>Court Booking</strong> option in the menu.</p>
        </div>`;
      footer.innerHTML = `
        <button class="btn btn-secondary" data-modal="bookingModal">Close</button>
        <button class="btn btn-primary" id="goToBookingBtn">Court Booking →</button>`;
      document.getElementById('goToBookingBtn').onclick = () => {
        Modal.close('bookingModal');
        if (typeof CourtBooking !== 'undefined') CourtBooking.openWith(venueId, courtIndex, dateStr, timeStr);
        else navigate('courtbooking');
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
