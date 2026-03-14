/**
 * data.js — Persistent state via localStorage
 * All data is stored under 'tcm_' prefix keys.
 */

const DB = {
  KEYS: {
    venues: 'tcm_venues',
    schools: 'tcm_schools',
    bookings: 'tcm_bookings',
    leagues: 'tcm_leagues',
    tournaments: 'tcm_tournaments',
    closures: 'tcm_closures',
    password: 'tcm_password',
    settings: 'tcm_settings',
  },

  _get(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
  },
  _set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },

  // ---- Venues ----
  getVenues() { return this._get(this.KEYS.venues) || []; },
  saveVenues(v) { this._set(this.KEYS.venues, v); },
  addVenue(venue) {
    const list = this.getVenues();
    venue.id = venue.id || uid();
    list.push(venue);
    this.saveVenues(list);
    return venue;
  },
  updateVenue(venue) {
    const list = this.getVenues().map(v => v.id === venue.id ? venue : v);
    this.saveVenues(list);
  },
  deleteVenue(id) { this.saveVenues(this.getVenues().filter(v => v.id !== id)); },

  // ---- Schools ----
  getSchools() { return this._get(this.KEYS.schools) || []; },
  saveSchools(s) { this._set(this.KEYS.schools, s); },
  addSchool(school) {
    const list = this.getSchools();
    school.id = school.id || uid();
    list.push(school);
    this.saveSchools(list);
    return school;
  },
  updateSchool(school) {
    const list = this.getSchools().map(s => s.id === school.id ? school : s);
    this.saveSchools(list);
  },
  deleteSchool(id) { this.saveSchools(this.getSchools().filter(s => s.id !== id)); },

  // ---- Bookings ----
  getBookings() { return this._get(this.KEYS.bookings) || []; },
  saveBookings(b) { this._set(this.KEYS.bookings, b); },
  addBooking(booking) {
    const list = this.getBookings();
    booking.id = booking.id || uid();
    list.push(booking);
    this.saveBookings(list);
    return booking;
  },
  updateBooking(booking) {
    const list = this.getBookings().map(b => b.id === booking.id ? booking : b);
    this.saveBookings(list);
  },
  deleteBooking(id) { this.saveBookings(this.getBookings().filter(b => b.id !== id)); },
  getBookingsForCell(venueId, courtIndex, dateStr) {
    return this.getBookings().filter(b =>
      b.venueId === venueId &&
      b.courtIndex === courtIndex &&
      b.date === dateStr
    );
  },

  // ---- Leagues ----
  getLeagues() { return this._get(this.KEYS.leagues) || []; },
  saveLeagues(l) { this._set(this.KEYS.leagues, l); },
  addLeague(league) {
    const list = this.getLeagues();
    league.id = league.id || uid();
    list.push(league);
    this.saveLeagues(list);
    return league;
  },
  updateLeague(league) {
    const list = this.getLeagues().map(l => l.id === league.id ? league : l);
    this.saveLeagues(list);
  },
  deleteLeague(id) { this.saveLeagues(this.getLeagues().filter(l => l.id !== id)); },

  // ---- Tournaments ----
  getTournaments() { return this._get(this.KEYS.tournaments) || []; },
  saveTournaments(t) { this._set(this.KEYS.tournaments, t); },
  addTournament(t) {
    const list = this.getTournaments();
    t.id = t.id || uid();
    list.push(t);
    this.saveTournaments(list);
    return t;
  },
  updateTournament(t) {
    const list = this.getTournaments().map(x => x.id === t.id ? t : x);
    this.saveTournaments(list);
  },
  deleteTournament(id) { this.saveTournaments(this.getTournaments().filter(t => t.id !== id)); },

  // ---- Closures ----
  getClosures() { return this._get(this.KEYS.closures) || []; },
  saveClosures(c) { this._set(this.KEYS.closures, c); },
  addClosure(c) {
    const list = this.getClosures();
    c.id = c.id || uid();
    list.push(c);
    this.saveClosures(list);
    return c;
  },
  deleteClosure(id) { this.saveClosures(this.getClosures().filter(c => c.id !== id)); },

  // ---- Password ----
  getPassword() { return this._get(this.KEYS.password) || 'admin'; },
  setPassword(p) { this._set(this.KEYS.password, p); },

  // ---- Settings ----
  getSettings() {
    return this._get(this.KEYS.settings) || {
      timeSlotStart: '07:00',
      timeSlotEnd: '21:00',
      slotDuration: 60,
    };
  },
  saveSettings(s) { this._set(this.KEYS.settings, s); },

  // ---- Seed demo data ----
  seed() {
    if (this.getVenues().length > 0) return; // already seeded

    // Venues
    const v1 = this.addVenue({ name: 'Riverside Tennis Club', address: '1 River Rd', courts: 4 });
    const v2 = this.addVenue({ name: 'Central Sports Complex', address: '20 Main St', courts: 6 });
    const v3 = this.addVenue({ name: 'Eastside Academy', address: '5 East Ave', courts: 3 });

    // Schools
    const s1 = this.addSchool({ name: 'Greenview High', venueId: v1.id, contact: 'Coach Adams', color: '#3b82f6' });
    const s2 = this.addSchool({ name: 'Sunridge College', venueId: v2.id, contact: 'Coach Brown', color: '#f59e0b' });
    const s3 = this.addSchool({ name: 'Northpeak Academy', venueId: v3.id, contact: 'Coach Chen', color: '#ef4444' });
    const s4 = this.addSchool({ name: 'Westbrook School', venueId: v1.id, contact: 'Coach Davis', color: '#8b5cf6' });
  },
};

// Closure / booking check helpers
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
    b.venueId === venueId &&
    b.courtIndex === courtIndex &&
    b.date === dateStr &&
    b.timeSlot === timeStr
  );
}

// Unique ID generator
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Date helpers
function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function weekStart(d) {
  const day = new Date(d);
  day.setDate(day.getDate() - day.getDay() + 1); // Monday
  return day;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatDate(str) {
  const d = parseDate(str);
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateShort(d) {
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Generate time slots from settings
function getTimeSlots() {
  const s = DB.getSettings();
  const slots = [];
  let [h, m] = s.timeSlotStart.split(':').map(Number);
  const [eh, em] = s.timeSlotEnd.split(':').map(Number);
  const endMins = eh * 60 + em;
  while (h * 60 + m < endMins) {
    slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    m += s.slotDuration;
    if (m >= 60) { h += Math.floor(m/60); m = m % 60; }
  }
  return slots;
}

function slotEndTime(timeStr, durationMins) {
  let [h, m] = timeStr.split(':').map(Number);
  m += durationMins;
  h += Math.floor(m/60); m = m % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// Initialize seed data
DB.seed();
