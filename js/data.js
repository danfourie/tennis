/**
 * data.js — Firebase Firestore-backed data layer
 *
 * Strategy:
 *   • All READ methods are synchronous — they pull from an in-memory cache.
 *   • All WRITE methods update the cache immediately (so the UI stays snappy)
 *     and fire an async Firestore write in the background.
 *   • DB.loadAll()      → called once on startup; populates the cache from Firestore.
 *   • DB.subscribeAll() → real-time onSnapshot listeners so every browser tab
 *                         stays in sync automatically.
 *   • DB.loadUsers()    → async, fetched separately (master-only, for Admin panel).
 *   • DB.writeAudit()   → lightweight event log stored in the auditLog collection.
 */

// ============================================================
// IN-MEMORY CACHE
// ============================================================
const _cache = {
  venues:         [],
  schools:        [],
  bookings:       [],
  leagues:        [],
  tournaments:    [],
  closures:       [],
  leagueEntries:  [],  // pending/approved team entries for leagues
  users:          [],  // loaded on demand by master
  notifications:  [],  // loaded per-user via subscribeNotifications
  settings: {
    timeSlotStart: '07:00',
    timeSlotEnd:   '21:00',
    slotDuration:  60,
  },
};

// ============================================================
// FIRESTORE SHORTHAND
// ============================================================
function _fs()        { return firebase.firestore(); }
function _col(name)   { return _fs().collection(name); }
function _doc(col,id) { return _fs().collection(col).doc(id); }

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
    _cache.schools.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
    // Prevent duplicate: same venue + court + date + time already booked/pending
    const duplicate = _cache.bookings.find(b =>
      b.venueId     === booking.venueId &&
      b.courtIndex  === booking.courtIndex &&
      b.date        === booking.date &&
      b.timeSlot    === booking.timeSlot &&
      b.status      !== 'rejected'
    );
    if (duplicate) return null;  // caller should check for null and toast
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
      b.venueId    === venueId &&
      b.courtIndex === courtIndex &&
      b.date       === dateStr
    );
  },

  // ── Pending booking helpers ────────────────────────────────
  getPendingBookings() {
    return _cache.bookings.filter(b => b.status === 'pending');
  },
  approveBooking(id) {
    const booking = _cache.bookings.find(b => b.id === id);
    if (!booking) return;
    booking.status = 'confirmed';
    booking.approvedAt = new Date().toISOString();
    this.updateBooking(booking);
  },
  rejectBooking(id) {
    this.deleteBooking(id);
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

  // ── League Entries ────────────────────────────────────────
  /**
   * leagueEntry shape:
   *   { id, leagueId, schoolId, teamSuffix, teamLabel,
   *     status: 'pending'|'approved'|'rejected',
   *     enteredBy, enteredByName, enteredAt,
   *     approvedBy?, approvedByName?, approvedAt?,
   *     movedToLeagueId?, note? }
   */
  getLeagueEntries()        { return _cache.leagueEntries; },
  getEntriesForLeague(lid)  { return _cache.leagueEntries.filter(e => e.leagueId === lid); },
  getEntriesForSchool(sid)  { return _cache.leagueEntries.filter(e => e.schoolId === sid); },

  addLeagueEntry(entry) {
    entry.id = entry.id || uid();
    _cache.leagueEntries.push(entry);
    _doc('leagueEntries', entry.id).set(entry).catch(console.error);
    return entry;
  },
  updateLeagueEntry(entry) {
    _cache.leagueEntries = _cache.leagueEntries.map(e => e.id === entry.id ? entry : e);
    _doc('leagueEntries', entry.id).set(entry).catch(console.error);
  },
  deleteLeagueEntry(id) {
    _cache.leagueEntries = _cache.leagueEntries.filter(e => e.id !== id);
    _doc('leagueEntries', id).delete().catch(console.error);
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

  // ── Users (master-only, loaded on demand) ─────────────────
  getUsers() { return _cache.users; },

  async loadUsers() {
    try {
      const snap = await _col('users').get();
      _cache.users = snap.docs.map(d => d.data());
    } catch (err) {
      console.warn('Could not load users:', err);
    }
    return _cache.users;
  },

  updateUser(user) {
    _cache.users = _cache.users.map(u => u.uid === user.uid ? user : u);
    _doc('users', user.uid).set(user).catch(console.error);
  },

  deleteUserProfile(uid) {
    _cache.users = _cache.users.filter(u => u.uid !== uid);
    _doc('users', uid).delete().catch(console.error);
  },

  // ── Notifications ─────────────────────────────────────────
  /**
   * Write a single notification document (fan-out: one doc per recipient uid).
   * Does NOT update the in-memory cache — the per-user onSnapshot listener handles that.
   */
  writeNotification(notif) {
    _doc('notifications', notif.id).set(notif).catch(console.error);
  },

  /**
   * Attach a real-time listener for a single user's notifications.
   * Returns the unsubscribe function.
   */
  subscribeNotifications(uid, callback) {
    return _col('notifications')
      .where('uid', '==', uid)
      .onSnapshot(
        snap => {
          const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          docs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
          callback(docs.slice(0, 50));
        },
        err => console.warn('Firestore listener [notifications]:', err)
      );
  },

  markNotificationRead(id) {
    _doc('notifications', id).update({ read: true }).catch(console.error);
  },

  markAllNotificationsRead(ids) {
    ids.forEach(id => _doc('notifications', id).update({ read: true }).catch(console.error));
  },

  // ── Audit Log ─────────────────────────────────────────────
  /**
   * Write an immutable audit record to the auditLog Firestore collection.
   * Called by all modules whenever a significant action is taken.
   *
   * @param {string} action      - Short action key, e.g. 'booking_approved'
   * @param {string} category    - 'booking' | 'league' | 'tournament' | 'admin' | 'user'
   * @param {string} description - Human-readable description of what happened
   * @param {string} [entityId]  - ID of the primary affected document
   * @param {string} [entityName]- Name of the primary affected document
   */
  writeAudit(action, category, description, entityId, entityName) {
    try {
      const profile = typeof Auth !== 'undefined' ? Auth.getProfile() : null;
      const entry = {
        id:          uid(),
        action,
        category,
        description,
        entityId:    entityId   || null,
        entityName:  entityName || null,
        by:          profile ? (profile.displayName || profile.email) : 'System',
        byUid:       profile ? profile.uid : null,
        at:          new Date().toISOString(),
      };
      _doc('auditLog', entry.id).set(entry).catch(console.error);
    } catch (err) {
      console.warn('Audit write failed:', err);
    }
  },

  async loadAuditLog(limit = 100) {
    try {
      const snap = await _col('auditLog')
        .orderBy('at', 'desc')
        .limit(limit)
        .get();
      return snap.docs.map(d => d.data());
    } catch (err) {
      console.warn('Could not load audit log:', err);
      return [];
    }
  },

  // ── Fixture clash detection ───────────────────────────────
  /**
   * Returns an array of { a, b } pairs where a and b are
   * { fixture, league, leagueId } objects whose fixtures collide:
   *   same venue + same date + overlapping courts + overlapping time window.
   * Only fixtures that have a venueId and date are considered.
   */
  detectFixtureClashes() {
    // Group all fixtures by venueId + date
    const groups = {};
    for (const league of _cache.leagues) {
      for (const f of (league.fixtures || [])) {
        if (!f.venueId || !f.date) continue;
        const key = `${f.venueId}|${f.date}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push({ fixture: f, league, leagueId: league.id });
      }
    }

    const clashes = [];
    for (const [key, entries] of Object.entries(groups)) {
      if (entries.length < 2) continue;

      // Look up venue court capacity
      const venueId   = entries[0].fixture.venueId;
      const venue     = _cache.venues.find(v => v.id === venueId);
      const capacity  = venue ? (venue.courts || 4) : 4;

      // Sum total courts needed at this venue+date
      const totalCourts = entries.reduce((sum, e) => sum + (e.fixture.courtsBooked || 3), 0);

      // Only flag as clashes when demand exceeds venue capacity
      if (totalCourts > capacity) {
        // Add every pair in the over-capacity group
        for (let i = 0; i < entries.length; i++) {
          for (let j = i + 1; j < entries.length; j++) {
            clashes.push({ a: entries[i], b: entries[j] });
          }
        }
      }
    }
    return clashes;
  },

  // ── Password (legacy stub) ────────────────────────────────
  getPassword() { return null; },
  setPassword()  { /* handled by Auth.changePassword() */ },

  // ── Settings ──────────────────────────────────────────────
  getSettings() { return _cache.settings; },

  saveSettings(s) {
    _cache.settings = s;
    _doc('settings', 'global').set(s).catch(console.error);
  },

  // ── Load all public collections from Firestore ────────────
  async loadAll() {
    const [venues, schools, bookings, leagues, tournaments, closures, leagueEntries, settingsDoc] =
      await Promise.all([
        _col('venues').get(),
        _col('schools').get(),
        _col('bookings').get(),
        _col('leagues').get(),
        _col('tournaments').get(),
        _col('closures').get(),
        _col('leagueEntries').get(),
        _doc('settings', 'global').get(),
      ]);

    _cache.venues         = venues.docs.map(d => d.data());
    _cache.schools        = schools.docs.map(d => d.data()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    _cache.bookings       = bookings.docs.map(d => d.data());
    _cache.leagues        = leagues.docs.map(d => d.data());
    _cache.tournaments    = tournaments.docs.map(d => d.data());
    _cache.closures       = closures.docs.map(d => d.data());
    _cache.leagueEntries  = leagueEntries.docs.map(d => d.data());
    if (settingsDoc.exists) _cache.settings = settingsDoc.data();

    // Seed demo data if this is a brand-new project
    if (_cache.venues.length === 0) await this._seed();
  },

  // ── Real-time subscriptions ───────────────────────────────
  subscribeAll(onUpdate) {
    const unsubs = [];

    const watch = (colName, cacheKey) => {
      const unsub = _col(colName).onSnapshot(
        snap => {
          const serverDocs = snap.docs.map(d => d.data());
          // Preserve any optimistic local entries not yet confirmed by Firestore
          // (they have an id that doesn't appear in the server snapshot yet).
          // This prevents newly added bookings/entries from disappearing while
          // Firestore processes the write.
          const serverIds = new Set(serverDocs.map(d => d.id).filter(Boolean));
          const localOnly = (_cache[cacheKey] || []).filter(d => d.id && !serverIds.has(d.id));
          _cache[cacheKey] = [...serverDocs, ...localOnly];
          if (onUpdate) onUpdate(colName);
        },
        err => console.warn(`Firestore listener [${colName}]:`, err)
      );
      unsubs.push(unsub);
    };

    watch('venues',        'venues');
    watch('schools',       'schools');
    watch('bookings',      'bookings');
    watch('leagues',       'leagues');
    watch('tournaments',   'tournaments');
    watch('closures',      'closures');
    watch('leagueEntries', 'leagueEntries');

    unsubs.push(
      _doc('settings', 'global').onSnapshot(
        doc => {
          if (doc.exists) { _cache.settings = doc.data(); if (onUpdate) onUpdate('settings'); }
        },
        err => console.warn('Firestore listener [settings]:', err)
      )
    );

    return () => unsubs.forEach(u => u());
  },

  // ── Demo seed data ────────────────────────────────────────
  async _seed() {
    const v1 = this.addVenue({ name: 'Riverside Tennis Club',  address: '1 River Rd',  courts: 4 });
    const v2 = this.addVenue({ name: 'Central Sports Complex', address: '20 Main St',  courts: 6 });
    const v3 = this.addVenue({ name: 'Eastside Academy',       address: '5 East Ave',  courts: 3 });
    this.addSchool({ name: 'Greenview High',    venueId: v1.id, contact: 'Coach Adams', color: '#3b82f6' });
    this.addSchool({ name: 'Sunridge College',  venueId: v2.id, contact: 'Coach Brown', color: '#f59e0b' });
    this.addSchool({ name: 'Northpeak Academy', venueId: v3.id, contact: 'Coach Chen',  color: '#ef4444' });
    this.addSchool({ name: 'Westbrook School',  venueId: v1.id, contact: 'Coach Davis', color: '#8b5cf6' });
  },
};

// ============================================================
// HELPER FUNCTIONS
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
    b.venueId    === venueId &&
    b.courtIndex === courtIndex &&
    b.date       === dateStr &&
    b.timeSlot   === timeStr
  );
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function toDateStr(d)       { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function parseDate(str)     { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); }
function weekStart(d)       { const day = new Date(d); day.setDate(day.getDate() - day.getDay() + 1); return day; }
function addDays(d, n)      { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function formatDate(str)    { return parseDate(str).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
function formatDateShort(d) { return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); }

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

/** Convert "HH:MM" to total minutes. */
function timeToMins(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}
