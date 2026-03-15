/**
 * data.js — Firebase Firestore-backed data layer
 *
 * Strategy:
 *   • All READ methods are synchronous — they pull from an in-memory cache.
 *   • All WRITE methods update the cache immediately (so the UI stays snappy)
 *     and fire an async Firestore write in the background.
 *   • DB.loadAll()     → called once on startup; populates the cache from Firestore.
 *   • DB.subscribeAll()→ sets up real-time onSnapshot listeners so every browser
 *                        tab stays in sync automatically.
 *
 * This design means calendar.js / leagues.js / admin.js etc. need NO changes
 * to their synchronous DB.getXxx() calls.
 */

// ============================================================
// IN-MEMORY CACHE
// ============================================================
const _cache = {
  venues:      [],
  schools:     [],
  bookings:    [],
  leagues:     [],
  tournaments: [],
  closures:    [],
  settings: {
    timeSlotStart: '07:00',
    timeSlotEnd:   '21:00',
    slotDuration:  60,
  },
};

// ============================================================
// FIRESTORE SHORTHAND
// ============================================================
function _fs() { return firebase.firestore(); }
function _col(name) { return _fs().collection(name); }
function _doc(col, id) { return _fs().collection(col).doc(id); }

// ============================================================
// DB OBJECT
// ============================================================
const DB = {

  // ── Venues ────────────────────────────────────────────────
  getVenues() { return _cache.venues; },

  addVenue(venue) {
    venue.id = venue.id || uid();
    _cache.venues.push(venue);
    _doc('venues', venue.id).set(venue).catch(console.error);
    return venue;
  },

  updateVenue(venue) {
    _cache.venues = _cache.venues.map(v => v.id === venue.id ? venue : v);
    _doc('venues', venue.id).set(venue).catch(console.error);
  },

  deleteVenue(id) {
    _cache.venues = _cache.venues.filter(v => v.id !== id);
    _doc('venues', id).delete().catch(console.error);
  },

  // ── Schools ───────────────────────────────────────────────
  getSchools() { return _cache.schools; },

  addSchool(school) {
    school.id = school.id || uid();
    _cache.schools.push(school);
    _doc('schools', school.id).set(school).catch(console.error);
    return school;
  },

  updateSchool(school) {
    _cache.schools = _cache.schools.map(s => s.id === school.id ? school : s);
    _doc('schools', school.id).set(school).catch(console.error);
  },

  deleteSchool(id) {
    _cache.schools = _cache.schools.filter(s => s.id !== id);
    _doc('schools', id).delete().catch(console.error);
  },

  // ── Bookings ──────────────────────────────────────────────
  getBookings() { return _cache.bookings; },

  addBooking(booking) {
    booking.id = booking.id || uid();
    _cache.bookings.push(booking);
    _doc('bookings', booking.id).set(booking).catch(console.error);
    return booking;
  },

  updateBooking(booking) {
    _cache.bookings = _cache.bookings.map(b => b.id === booking.id ? booking : b);
    _doc('bookings', booking.id).set(booking).catch(console.error);
  },

  deleteBooking(id) {
    _cache.bookings = _cache.bookings.filter(b => b.id !== id);
    _doc('bookings', id).delete().catch(console.error);
  },

  getBookingsForCell(venueId, courtIndex, dateStr) {
    return _cache.bookings.filter(b =>
      b.venueId     === venueId  &&
      b.courtIndex  === courtIndex &&
      b.date        === dateStr
    );
  },

  // ── Leagues ───────────────────────────────────────────────
  getLeagues() { return _cache.leagues; },

  addLeague(league) {
    league.id = league.id || uid();
    _cache.leagues.push(league);
    _doc('leagues', league.id).set(league).catch(console.error);
    return league;
  },

  updateLeague(league) {
    _cache.leagues = _cache.leagues.map(l => l.id === league.id ? league : l);
    _doc('leagues', league.id).set(league).catch(console.error);
  },

  deleteLeague(id) {
    _cache.leagues = _cache.leagues.filter(l => l.id !== id);
    _doc('leagues', id).delete().catch(console.error);
  },

  // ── Tournaments ───────────────────────────────────────────
  getTournaments() { return _cache.tournaments; },

  addTournament(t) {
    t.id = t.id || uid();
    _cache.tournaments.push(t);
    _doc('tournaments', t.id).set(t).catch(console.error);
    return t;
  },

  updateTournament(t) {
    _cache.tournaments = _cache.tournaments.map(x => x.id === t.id ? t : x);
    _doc('tournaments', t.id).set(t).catch(console.error);
  },

  deleteTournament(id) {
    _cache.tournaments = _cache.tournaments.filter(t => t.id !== id);
    _doc('tournaments', id).delete().catch(console.error);
  },

  // ── Closures ──────────────────────────────────────────────
  getClosures() { return _cache.closures; },

  addClosure(c) {
    c.id = c.id || uid();
    _cache.closures.push(c);
    _doc('closures', c.id).set(c).catch(console.error);
    return c;
  },

  deleteClosure(id) {
    _cache.closures = _cache.closures.filter(c => c.id !== id);
    _doc('closures', id).delete().catch(console.error);
  },

  // ── Password (legacy stub — now handled by Firebase Auth) ─
  getPassword() { return null; },
  setPassword()  { /* no-op: password changes go through Auth.changePassword() */ },

  // ── Settings ──────────────────────────────────────────────
  getSettings() { return _cache.settings; },

  saveSettings(s) {
    _cache.settings = s;
    _doc('settings', 'global').set(s).catch(console.error);
  },

  // ── Load all collections from Firestore (called on startup) ──
  async loadAll() {
    const db = _fs();

    const [venues, schools, bookings, leagues, tournaments, closures, settingsDoc] =
      await Promise.all([
        _col('venues').get(),
        _col('schools').get(),
        _col('bookings').get(),
        _col('leagues').get(),
        _col('tournaments').get(),
        _col('closures').get(),
        _doc('settings', 'global').get(),
      ]);

    _cache.venues      = venues.docs.map(d => d.data());
    _cache.schools     = schools.docs.map(d => d.data());
    _cache.bookings    = bookings.docs.map(d => d.data());
    _cache.leagues     = leagues.docs.map(d => d.data());
    _cache.tournaments = tournaments.docs.map(d => d.data());
    _cache.closures    = closures.docs.map(d => d.data());
    if (settingsDoc.exists) _cache.settings = settingsDoc.data();

    // Seed demo data only when this is a brand-new Firestore project
    if (_cache.venues.length === 0) {
      await this._seed();
    }
  },

  // ── Real-time subscriptions ────────────────────────────────
  /**
   * Sets up onSnapshot listeners for every collection.
   * @param {Function} onUpdate  Called with the collection name after each update.
   * @returns {Function}         Call to unsubscribe all listeners.
   */
  subscribeAll(onUpdate) {
    const unsubs = [];

    const watch = (colName, cacheKey) => {
      const unsub = _col(colName).onSnapshot(
        snap => {
          _cache[cacheKey] = snap.docs.map(d => d.data());
          if (onUpdate) onUpdate(colName);
        },
        err => console.warn(`Firestore listener error [${colName}]:`, err)
      );
      unsubs.push(unsub);
    };

    watch('venues',      'venues');
    watch('schools',     'schools');
    watch('bookings',    'bookings');
    watch('leagues',     'leagues');
    watch('tournaments', 'tournaments');
    watch('closures',    'closures');

    // Settings doc listener
    const settingsUnsub = _doc('settings', 'global').onSnapshot(
      doc => {
        if (doc.exists) {
          _cache.settings = doc.data();
          if (onUpdate) onUpdate('settings');
        }
      },
      err => console.warn('Firestore listener error [settings]:', err)
    );
    unsubs.push(settingsUnsub);

    return () => unsubs.forEach(u => u());
  },

  // ── Seed demo data into Firestore ─────────────────────────
  async _seed() {
    const v1 = this.addVenue({ name: 'Riverside Tennis Club',  address: '1 River Rd',   courts: 4 });
    const v2 = this.addVenue({ name: 'Central Sports Complex', address: '20 Main St',   courts: 6 });
    const v3 = this.addVenue({ name: 'Eastside Academy',       address: '5 East Ave',   courts: 3 });
    this.addSchool({ name: 'Greenview High',    venueId: v1.id, contact: 'Coach Adams', color: '#3b82f6' });
    this.addSchool({ name: 'Sunridge College',  venueId: v2.id, contact: 'Coach Brown', color: '#f59e0b' });
    this.addSchool({ name: 'Northpeak Academy', venueId: v3.id, contact: 'Coach Chen',  color: '#ef4444' });
    this.addSchool({ name: 'Westbrook School',  venueId: v1.id, contact: 'Coach Davis', color: '#8b5cf6' });
  },
};

// ============================================================
// HELPER FUNCTIONS (unchanged from original)
// ============================================================

function isCourtClosed(venueId, courtIndex, dateStr, timeStr) {
  return DB.getClosures().some(c => {
    if (c.venueId !== venueId) return false;
    if (c.courtIndex !== null && c.courtIndex !== undefined && c.courtIndex !== '' && c.courtIndex != courtIndex) return false;
    if (dateStr < c.startDate || dateStr > c.endDate) return false;
    if (c.timeStart && c.timeEnd && timeStr) {
      if (timeStr < c.timeStart || timeStr >= c.timeEnd) return false;
    }
    return true;
  });
}

function getSlotBooking(venueId, courtIndex, dateStr, timeStr) {
  return DB.getBookings().find(b =>
    b.venueId     === venueId  &&
    b.courtIndex  === courtIndex &&
    b.date        === dateStr  &&
    b.timeSlot    === timeStr
  );
}

// Unique ID generator
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Date helpers
function toDateStr(d)      { return d.toISOString().slice(0, 10); }
function parseDate(str)    { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); }
function weekStart(d)      { const day = new Date(d); day.setDate(day.getDate() - day.getDay() + 1); return day; }
function addDays(d, n)     { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function formatDate(str)   { return parseDate(str).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
function formatDateShort(d){ return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); }

const DAY_NAMES      = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function getTimeSlots() {
  const s = DB.getSettings();
  const slots = [];
  let [h, m] = s.timeSlotStart.split(':').map(Number);
  const [eh, em] = s.timeSlotEnd.split(':').map(Number);
  const endMins = eh * 60 + em;
  while (h * 60 + m < endMins) {
    slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    m += s.slotDuration;
    if (m >= 60) { h += Math.floor(m / 60); m = m % 60; }
  }
  return slots;
}

function slotEndTime(timeStr, durationMins) {
  let [h, m] = timeStr.split(':').map(Number);
  m += durationMins;
  h += Math.floor(m / 60); m = m % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
