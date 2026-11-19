/**
 * SFCC Skills Arena — Google Apps Script port.
 *
 * Storage: a single Google Spreadsheet (one tab per "table"). Its ID is kept in
 * ScriptProperties under SHEET_ID — created on first run.
 *
 * Auth: random opaque token returned to the browser and stored in localStorage;
 * every call sends it back as `token`. Passwords are PBKDF2(SHA-256, 100k)
 * — not bcrypt, because Apps Script has no bcrypt and Utilities ships SHA-256.
 *
 * Routing: a single `api(route, payload)` function invoked from the client via
 * google.script.run. `doGet()` just serves the HTML shell.
 */

var SHEETS = {
  users:         ['id','name','email','password_hash','role','created_at'],
  sessions:      ['token','user_id','expires_at','created_at'],
  tracks:        ['id','slug','title','description','icon','points_per_question','pass_percent','sort_order'],
  questions:     ['id','track_id','text','type','difficulty','points','explanation','sort_order'],
  options:       ['id','question_id','text','is_correct','sort_order'],
  attempts:      ['id','user_id','track_id','started_at','finished_at','score','max_score','passed'],
  attempt_answers: ['id','attempt_id','question_id','selected_option_ids','is_correct','points_awarded'],
  earned_question_points: ['user_id','question_id','track_id','attempt_id','points','earned_at'],
  points_ledger: ['id','user_id','track_id','attempt_id','question_id','points','reason','created_at']
};

var SESSION_DAYS = 14;

// ---------- HTTP entry points ----------

function doGet(e) {
  ensureSchema_();
  var tpl = HtmlService.createTemplateFromFile('Index');
  tpl.webAppUrl = ScriptApp.getService().getUrl() || '';
  return tpl.evaluate()
    .setTitle('SFCC Skills Arena')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Single client entry — client calls google.script.run.api(route, payload). */
function api(route, payload) {
  payload = payload || {};
  try {
    ensureSchema_();
    var handler = ROUTES[route];
    if (!handler) return err_('Unknown route: ' + route, 404);
    var result = handler(payload);
    // Force a JSON roundtrip so Date/undefined/etc. don't sneak through the
    // google.script.run bridge as `null`.
    return JSON.parse(JSON.stringify(result == null ? {} : result));
  } catch (ex) {
    var msg = (ex && ex.message) ? ex.message : String(ex);
    var stack = (ex && ex.stack) ? String(ex.stack).slice(0, 500) : '';
    console.error('api(' + route + ') failed: ' + msg + '\n' + stack);
    return err_(msg + (stack ? ' | ' + stack : ''), 500);
  }
}

function ok_(data)        { return Object.assign({ ok: true }, data || {}); }
function err_(msg, code)  { return { ok: false, error: msg, status: code || 400 }; }

/** Coerce a sheet cell value to a plain string (Sheets auto-parses dates). */
function cellToStr_(v) {
  if (v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return v.toISOString().replace('T', ' ').slice(0, 19);
  }
  return String(v);
}

// ---------- Spreadsheet-as-DB helpers ----------

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  var ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('SFCC Skills Arena DB');
    PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  }
  return ss;
}

function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = createSheet_(ss, name);
  return sh;
}

function createSheet_(ss, name) {
  var sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
  // Force every column to plain text so Sheets doesn't auto-parse
  // "2026-11-20 14:30:00" into a Date object (which then round-trips as a
  // native Date and breaks google.script.run serialization).
  sh.getRange(1, 1, sh.getMaxRows(), SHEETS[name].length).setNumberFormat('@');
  return sh;
}

function ensureSchema_() {
  var ss = ss_();
  Object.keys(SHEETS).forEach(function (name) {
    if (!ss.getSheetByName(name)) createSheet_(ss, name);
  });
  // Drop the default "Sheet1" that Spreadsheet creation leaves behind.
  var junk = ss.getSheetByName('Sheet1');
  if (junk && ss.getSheets().length > 1) ss.deleteSheet(junk);
  seedIfEmpty_();
}

function allRows_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var cols = SHEETS[name].length;
  var values = sh.getRange(2, 1, last - 1, cols).getValues();
  return values.map(function (row) { return rowToObj_(name, row); });
}

var DATE_COLS = { expires_at:1, created_at:1, started_at:1, finished_at:1, earned_at:1 };
function rowToObj_(name, row) {
  var obj = {};
  SHEETS[name].forEach(function (col, i) {
    var v = row[i];
    if (DATE_COLS[col]) obj[col] = cellToStr_(v);
    else obj[col] = v;
  });
  return obj;
}

function append_(name, obj) {
  var sh = sheet_(name);
  var row = SHEETS[name].map(function (col) { return obj[col] == null ? '' : obj[col]; });
  sh.appendRow(row);
}

function nextId_(name) {
  var rows = allRows_(name);
  var max = 0;
  rows.forEach(function (r) { if (Number(r.id) > max) max = Number(r.id); });
  return max + 1;
}

function findOne_(name, predicate) {
  var rows = allRows_(name);
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) return { row: rows[i], index: i };
  return null;
}

function findAll_(name, predicate) {
  return allRows_(name).filter(predicate);
}

function updateRow_(name, rowIndex, patch) {
  var sh = sheet_(name);
  var current = rowToObj_(name, sh.getRange(rowIndex + 2, 1, 1, SHEETS[name].length).getValues()[0]);
  Object.keys(patch).forEach(function (k) { current[k] = patch[k]; });
  var row = SHEETS[name].map(function (col) { return current[col] == null ? '' : current[col]; });
  sh.getRange(rowIndex + 2, 1, 1, SHEETS[name].length).setValues([row]);
}

function deleteWhere_(name, predicate) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return;
  var cols = SHEETS[name].length;
  var values = sh.getRange(2, 1, last - 1, cols).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (predicate(rowToObj_(name, values[i]))) sh.deleteRow(i + 2);
  }
}

function nowIso_() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ---------- Auth ----------

/**
 * Apps Script has no bcrypt and real PBKDF2 (100k rounds of HMAC) blows past
 * the 6-minute script timeout. This scheme is deliberately modest:
 * iterated SHA-256 (salt || password || prev). 1000 rounds takes ~100 ms —
 * enough to make brute force annoying without burning the quota on every login.
 *
 * Stored format:  sha256x<iter>$<salt-hex>$<digest-hex>
 */
var PW_ITERATIONS = 1000;

function hashPassword_(password, saltHex) {
  var salt = saltHex || bytesToHex_(getRandomBytes_(16));
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + ':' + password,
    Utilities.Charset.UTF_8
  );
  for (var i = 1; i < PW_ITERATIONS; i++) {
    digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      bytesToHex_(digest) + ':' + password,
      Utilities.Charset.UTF_8
    );
  }
  return 'sha256x' + PW_ITERATIONS + '$' + salt + '$' + bytesToHex_(digest);
}

function verifyPassword_(password, stored) {
  if (!stored || String(stored).indexOf('sha256x') !== 0) return false;
  var parts = String(stored).split('$');
  if (parts.length !== 3) return false;
  var candidate = hashPassword_(password, parts[1]);
  // Constant-time compare on strings (fine for hex).
  if (candidate.length !== stored.length) return false;
  var mismatch = 0;
  for (var i = 0; i < candidate.length; i++) {
    mismatch |= candidate.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return mismatch === 0;
}

function getRandomBytes_(n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(Math.floor(Math.random() * 256));
  return out;
}
function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function createSession_(userId) {
  var token = bytesToHex_(getRandomBytes_(32));
  var expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  append_('sessions', { token: token, user_id: userId, expires_at: expires, created_at: nowIso_() });
  return token;
}

function destroySession_(token) {
  if (!token) return;
  deleteWhere_('sessions', function (s) { return s.token === token; });
}

function loadUserByToken_(token) {
  if (!token) return null;
  var hit = findOne_('sessions', function (s) { return s.token === token; });
  if (!hit) return null;
  if (new Date(String(hit.row.expires_at).replace(' ', 'T') + 'Z') < new Date()) return null;
  var userHit = findOne_('users', function (u) { return Number(u.id) === Number(hit.row.user_id); });
  if (!userHit) return null;
  var u = userHit.row;
  var totals = userTotals_(Number(u.id));
  return {
    id: Number(u.id),
    name: u.name,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
    total_points: totals.total_points,
    questions_mastered: totals.questions_mastered
  };
}

function userTotals_(userId) {
  var total = 0;
  findAll_('points_ledger', function (l) { return Number(l.user_id) === userId; })
    .forEach(function (l) { total += Number(l.points) || 0; });
  var mastered = findAll_('earned_question_points', function (e) { return Number(e.user_id) === userId; }).length;
  return { total_points: total, questions_mastered: mastered };
}

function requireUser_(payload) {
  var user = loadUserByToken_(payload && payload.token);
  if (!user) throw new Error('Sign in required.');
  return user;
}

function requireAdmin_(payload) {
  var user = requireUser_(payload);
  if (user.role !== 'admin') throw new Error('Admins only.');
  return user;
}

// ---------- Seeding ----------

function seedIfEmpty_() {
  if (allRows_('tracks').length === 0) seedCatalog_();
  if (allRows_('users').length === 0) seedDemoUsers_();
  seedDemoProgress_();
}

function seedCatalog_() {
  var raw = SEED_QUESTIONS_JSON(); // defined in Questions.gs
  var data = JSON.parse(raw);
  data.tracks.forEach(function (t, ti) {
    var trackId = nextId_('tracks');
    append_('tracks', {
      id: trackId,
      slug: t.slug,
      title: t.title,
      description: t.description,
      icon: t.icon,
      points_per_question: t.pointsPerQuestion,
      pass_percent: t.passPercent,
      sort_order: t.sortOrder || (ti + 1)
    });
    t.questions.forEach(function (q, qi) {
      var qid = nextId_('questions');
      append_('questions', {
        id: qid, track_id: trackId, text: q.text, type: q.type,
        difficulty: q.difficulty, points: q.points, explanation: q.explanation,
        sort_order: qi + 1
      });
      q.options.forEach(function (opt, oi) {
        append_('options', {
          id: nextId_('options'), question_id: qid, text: opt.text,
          is_correct: opt.correct ? 1 : 0, sort_order: oi + 1
        });
      });
    });
  });
}

function seedDemoUsers_() {
  var seeds = [
    { name: 'Arena Admin', email: 'admin@arena.local', password: 'ChangeMe!admin', role: 'admin' },
    { name: 'Alex Rivera', email: 'alex@arena.local',  password: 'demo1234',       role: 'dev' },
    { name: 'Jordan Patel', email: 'jordan@arena.local', password: 'demo1234',     role: 'dev' },
    { name: 'Sam Okonkwo', email: 'sam@arena.local',   password: 'demo1234',       role: 'dev' }
  ];
  seeds.forEach(function (u) {
    append_('users', {
      id: nextId_('users'),
      name: u.name, email: u.email,
      password_hash: hashPassword_(u.password),
      role: u.role, created_at: nowIso_()
    });
  });
}

function seedDemoProgress_() {
  var alex = findOne_('users', function (u) { return u.email === 'alex@arena.local'; });
  var jordan = findOne_('users', function (u) { return u.email === 'jordan@arena.local'; });
  if (!alex || !jordan) return;
  if (findAll_('points_ledger', function (l) { return Number(l.user_id) === Number(alex.row.id) || Number(l.user_id) === Number(jordan.row.id); }).length > 0) return;

  function awardCorrect(userId, trackSlug, count) {
    var track = findOne_('tracks', function (t) { return t.slug === trackSlug; });
    if (!track) return;
    var qs = findAll_('questions', function (q) { return Number(q.track_id) === Number(track.row.id); })
      .sort(function (a, b) { return Number(a.sort_order) - Number(b.sort_order); })
      .slice(0, count);
    var attemptId = nextId_('attempts');
    var score = 0, max = 0;
    qs.forEach(function (q) { score += Number(q.points); max += Number(q.points); });
    append_('attempts', {
      id: attemptId, user_id: userId, track_id: track.row.id,
      started_at: nowIso_(), finished_at: nowIso_(),
      score: score, max_score: max, passed: 1
    });
    qs.forEach(function (q) {
      append_('earned_question_points', {
        user_id: userId, question_id: q.id, track_id: track.row.id,
        attempt_id: attemptId, points: q.points, earned_at: nowIso_()
      });
      append_('points_ledger', {
        id: nextId_('points_ledger'),
        user_id: userId, track_id: track.row.id, attempt_id: attemptId,
        question_id: q.id, points: q.points, reason: 'correct_first_time', created_at: nowIso_()
      });
    });
  }

  awardCorrect(Number(alex.row.id), 'architecture', 5);
  awardCorrect(Number(alex.row.id), 'sfra', 3);
  awardCorrect(Number(jordan.row.id), 'architecture', 3);
  awardCorrect(Number(jordan.row.id), 'apis', 4);
}

// ---------- Validation helpers ----------

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseIds_(raw) {
  if (!raw && raw !== 0) return [];
  try {
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter(function (n) { return Number.isInteger(n) && n > 0; });
  } catch (e) { return []; }
}

function sameSet_(a, b) {
  if (a.length !== b.length) return false;
  var left = a.slice().sort(function (x, y) { return x - y; });
  var right = b.slice().sort(function (x, y) { return x - y; });
  for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

// ---------- Route handlers ----------

var ROUTES = {
  'auth.me': function (p) {
    var user = loadUserByToken_(p.token);
    if (!user) return err_('Not signed in.', 401);
    return ok_({ user: user });
  },

  'auth.register': function (p) {
    var name = String(p.name || '').trim();
    var email = String(p.email || '').trim().toLowerCase();
    var password = String(p.password || '');
    if (name.length < 2) return err_('Name must be at least 2 characters.');
    if (!EMAIL_RE.test(email)) return err_('Enter a valid email.');
    if (password.length < 8) return err_('Password must be at least 8 characters.');

    if (findOne_('users', function (u) { return String(u.email).toLowerCase() === email; })) {
      return err_('That email is already registered.', 409);
    }
    var role = allRows_('users').length === 0 ? 'admin' : 'dev';
    var id = nextId_('users');
    append_('users', {
      id: id, name: name, email: email,
      password_hash: hashPassword_(password),
      role: role, created_at: nowIso_()
    });
    var token = createSession_(id);
    return ok_({ token: token, user: loadUserByToken_(token) });
  },

  'auth.login': function (p) {
    var email = String(p.email || '').trim().toLowerCase();
    var password = String(p.password || '');
    var hit = findOne_('users', function (u) { return String(u.email).toLowerCase() === email; });
    if (!hit || !verifyPassword_(password, hit.row.password_hash)) return err_('Invalid email or password.', 401);
    var token = createSession_(Number(hit.row.id));
    return ok_({ token: token, user: loadUserByToken_(token) });
  },

  'auth.logout': function (p) {
    requireUser_(p);
    destroySession_(p.token);
    return ok_({});
  },

  'tracks.list': function (p) {
    var user = requireUser_(p);
    var tracks = allRows_('tracks').sort(function (a, b) {
      return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id);
    });
    var allQuestions = allRows_('questions');
    var earned = findAll_('earned_question_points', function (e) { return Number(e.user_id) === user.id; });
    var finished = findAll_('attempts', function (a) { return Number(a.user_id) === user.id && a.finished_at; });
    var out = tracks.map(function (t) {
      var qs = allQuestions.filter(function (q) { return Number(q.track_id) === Number(t.id); });
      var e = earned.filter(function (x) { return Number(x.track_id) === Number(t.id); });
      var attempts = finished.filter(function (a) { return Number(a.track_id) === Number(t.id); });
      var best = attempts.reduce(function (acc, a) {
        return (acc == null || Number(a.score) > Number(acc.score)) ? a : acc;
      }, null);
      return {
        id: Number(t.id), slug: t.slug, title: t.title, description: t.description, icon: t.icon,
        points_per_question: Number(t.points_per_question),
        pass_percent: Number(t.pass_percent), sort_order: Number(t.sort_order),
        question_count: qs.length,
        available_points: qs.reduce(function (s, q) { return s + Number(q.points); }, 0),
        mastered_count: e.length,
        earned_points: e.reduce(function (s, x) { return s + Number(x.points); }, 0),
        best_score: best ? Number(best.score) : null,
        best_max: best ? Number(best.max_score) : null,
        last_finished_at: attempts.length ? attempts.sort(function (a, b) {
          return String(a.finished_at) < String(b.finished_at) ? 1 : -1;
        })[0].finished_at : null
      };
    });
    return ok_({ tracks: out });
  },

  'tracks.start': function (p) {
    var user = requireUser_(p);
    var trackHit = findOne_('tracks', function (t) { return String(t.id) === String(p.trackId) || t.slug === String(p.trackId); });
    if (!trackHit) return err_('Track not found.', 404);
    var trackId = Number(trackHit.row.id);
    var questions = findAll_('questions', function (q) { return Number(q.track_id) === trackId; })
      .sort(function (a, b) { return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id); });
    if (!questions.length) return err_('This track has no questions yet.');

    var open = findAll_('attempts', function (a) {
      return Number(a.user_id) === user.id && Number(a.track_id) === trackId && !a.finished_at;
    }).sort(function (a, b) { return String(a.started_at) < String(b.started_at) ? 1 : -1; })[0];

    var attemptId;
    if (open) {
      attemptId = Number(open.id);
    } else {
      attemptId = nextId_('attempts');
      append_('attempts', {
        id: attemptId, user_id: user.id, track_id: trackId,
        started_at: nowIso_(), finished_at: '',
        score: 0, max_score: 0, passed: 0
      });
    }

    var saved = findAll_('attempt_answers', function (a) { return Number(a.attempt_id) === attemptId; });
    var byQ = {};
    saved.forEach(function (a) { byQ[Number(a.question_id)] = parseIds_(a.selected_option_ids); });

    var payload = questions.map(function (q) {
      var opts = findAll_('options', function (o) { return Number(o.question_id) === Number(q.id); })
        .sort(function (a, b) { return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id); });
      return {
        id: Number(q.id), text: q.text, type: q.type, difficulty: q.difficulty, points: Number(q.points),
        options: opts.map(function (o) { return { id: Number(o.id), text: o.text }; }),
        selectedOptionIds: byQ[Number(q.id)] || []
      };
    });
    return ok_({ attemptId: attemptId, trackId: trackId, questions: payload });
  },

  'attempts.answer': function (p) {
    var user = requireUser_(p);
    var attemptHit = findOne_('attempts', function (a) { return Number(a.id) === Number(p.attemptId) && Number(a.user_id) === user.id; });
    if (!attemptHit) return err_('Attempt not found.', 404);
    if (attemptHit.row.finished_at) return err_('This attempt is already finished.');

    var questionId = Number(p.questionId);
    var optionIds = Array.isArray(p.optionIds) ? p.optionIds.map(Number) : [];
    var qHit = findOne_('questions', function (q) { return Number(q.id) === questionId && Number(q.track_id) === Number(attemptHit.row.track_id); });
    if (!qHit) return err_('Question is not part of this track.');

    var validIds = findAll_('options', function (o) { return Number(o.question_id) === questionId; }).map(function (o) { return Number(o.id); });
    for (var i = 0; i < optionIds.length; i++) if (validIds.indexOf(optionIds[i]) === -1) return err_('Invalid option selected.');
    if (qHit.row.type === 'single' && optionIds.length > 1) return err_('Pick a single answer.');

    var existing = findOne_('attempt_answers', function (a) { return Number(a.attempt_id) === Number(p.attemptId) && Number(a.question_id) === questionId; });
    if (existing) {
      updateRow_('attempt_answers', existing.index, { selected_option_ids: JSON.stringify(optionIds) });
    } else {
      append_('attempt_answers', {
        id: nextId_('attempt_answers'), attempt_id: Number(p.attemptId),
        question_id: questionId, selected_option_ids: JSON.stringify(optionIds),
        is_correct: '', points_awarded: 0
      });
    }
    return ok_({});
  },

  'attempts.finish': function (p) {
    var user = requireUser_(p);
    var attemptHit = findOne_('attempts', function (a) { return Number(a.id) === Number(p.attemptId) && Number(a.user_id) === user.id; });
    if (!attemptHit) return err_('Attempt not found.', 404);
    if (attemptHit.row.finished_at) return err_('This attempt is already finished.');
    var attempt = attemptHit.row;
    var attemptId = Number(attempt.id);
    var trackId = Number(attempt.track_id);

    var incoming = Array.isArray(p.answers) ? p.answers : [];
    incoming.forEach(function (ans) {
      var qid = Number(ans.questionId);
      var optionIds = Array.isArray(ans.optionIds) ? ans.optionIds.map(Number) : [];
      var qHit = findOne_('questions', function (q) { return Number(q.id) === qid && Number(q.track_id) === trackId; });
      if (!qHit) return;
      var existing = findOne_('attempt_answers', function (a) { return Number(a.attempt_id) === attemptId && Number(a.question_id) === qid; });
      if (existing) {
        updateRow_('attempt_answers', existing.index, { selected_option_ids: JSON.stringify(optionIds) });
      } else {
        append_('attempt_answers', {
          id: nextId_('attempt_answers'), attempt_id: attemptId,
          question_id: qid, selected_option_ids: JSON.stringify(optionIds),
          is_correct: '', points_awarded: 0
        });
      }
    });

    var questions = findAll_('questions', function (q) { return Number(q.track_id) === trackId; })
      .sort(function (a, b) { return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id); });
    var trackHit = findOne_('tracks', function (t) { return Number(t.id) === trackId; });
    var passPercent = Number(trackHit.row.pass_percent);

    var score = 0, maxScore = 0, newlyEarned = 0;
    var review = [];

    questions.forEach(function (q) {
      maxScore += Number(q.points);
      var opts = findAll_('options', function (o) { return Number(o.question_id) === Number(q.id); })
        .sort(function (a, b) { return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id); });
      var correctIds = opts.filter(function (o) { return Number(o.is_correct) === 1; }).map(function (o) { return Number(o.id); });
      var savedHit = findOne_('attempt_answers', function (a) { return Number(a.attempt_id) === attemptId && Number(a.question_id) === Number(q.id); });
      var selected = savedHit ? parseIds_(savedHit.row.selected_option_ids) : [];
      var isCorrect = sameSet_(selected, correctIds);
      if (isCorrect) score += Number(q.points);

      var awarded = 0;
      if (isCorrect) {
        var already = findOne_('earned_question_points', function (e) {
          return Number(e.user_id) === user.id && Number(e.question_id) === Number(q.id);
        });
        if (!already) {
          awarded = Number(q.points);
          newlyEarned += awarded;
          append_('earned_question_points', {
            user_id: user.id, question_id: Number(q.id), track_id: trackId,
            attempt_id: attemptId, points: awarded, earned_at: nowIso_()
          });
          append_('points_ledger', {
            id: nextId_('points_ledger'),
            user_id: user.id, track_id: trackId, attempt_id: attemptId,
            question_id: Number(q.id), points: awarded, reason: 'correct_first_time',
            created_at: nowIso_()
          });
        }
      }

      if (savedHit) {
        updateRow_('attempt_answers', savedHit.index, {
          selected_option_ids: JSON.stringify(selected),
          is_correct: isCorrect ? 1 : 0, points_awarded: awarded
        });
      } else {
        append_('attempt_answers', {
          id: nextId_('attempt_answers'), attempt_id: attemptId,
          question_id: Number(q.id), selected_option_ids: JSON.stringify(selected),
          is_correct: isCorrect ? 1 : 0, points_awarded: awarded
        });
      }

      review.push({
        id: Number(q.id), text: q.text, type: q.type, difficulty: q.difficulty,
        points: Number(q.points), explanation: q.explanation,
        selectedOptionIds: selected, correctOptionIds: correctIds,
        isCorrect: isCorrect, pointsAwarded: awarded,
        options: opts.map(function (o) { return { id: Number(o.id), text: o.text, isCorrect: Number(o.is_correct) === 1 }; })
      });
    });

    var passed = maxScore > 0 && (score / maxScore) * 100 >= passPercent ? 1 : 0;
    updateRow_('attempts', attemptHit.index, {
      finished_at: nowIso_(), score: score, max_score: maxScore, passed: passed
    });

    var totals = userTotals_(user.id);
    return ok_({
      attemptId: attemptId, trackId: trackId,
      score: score, maxScore: maxScore, passed: Boolean(passed),
      newlyEarned: newlyEarned,
      totalPoints: totals.total_points,
      questionsMastered: totals.questions_mastered,
      review: review
    });
  },

  'leaderboard.list': function (p) {
    requireUser_(p);
    var trackId = p.trackId ? Number(p.trackId) : null;
    var windowDays = p.window === '7d' ? 7 : null;
    var tracks = allRows_('tracks').sort(function (a, b) {
      return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id);
    }).map(function (t) { return { id: Number(t.id), slug: t.slug, title: t.title }; });

    var cutoff = windowDays ? new Date(Date.now() - windowDays * 86400000) : null;
    var ledger = allRows_('points_ledger').filter(function (l) {
      if (trackId != null && Number(l.track_id) !== trackId) return false;
      if (cutoff && new Date(String(l.created_at).replace(' ', 'T') + 'Z') < cutoff) return false;
      return true;
    });
    var earned = allRows_('earned_question_points');

    var devUsers = allRows_('users').filter(function (u) { return u.role !== 'admin'; });
    var entries = devUsers.map(function (u) {
      var uid = Number(u.id);
      var points = ledger.filter(function (l) { return Number(l.user_id) === uid; }).reduce(function (s, l) { return s + Number(l.points); }, 0);
      var mastered = earned.filter(function (e) { return Number(e.user_id) === uid && (trackId == null || Number(e.track_id) === trackId); }).length;
      var tracksCount = (new Set(earned.filter(function (e) { return Number(e.user_id) === uid; }).map(function (e) { return Number(e.track_id); }))).size;
      return trackId != null
        ? { user_id: uid, name: u.name, points: points, mastered: mastered }
        : { user_id: uid, name: u.name, points: points, mastered: mastered, tracks: tracksCount };
    }).sort(function (a, b) {
      return b.points - a.points || b.mastered - a.mastered || String(a.name).localeCompare(String(b.name));
    });

    return ok_({ tracks: tracks, entries: entries, trackId: trackId, window: windowDays ? '7d' : 'all' });
  },

  'me.progress': function (p) {
    var user = requireUser_(p);
    var tracks = allRows_('tracks').sort(function (a, b) {
      return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id);
    });
    var questions = allRows_('questions');
    var earned = findAll_('earned_question_points', function (e) { return Number(e.user_id) === user.id; });
    var trackSummaries = tracks.map(function (t) {
      var qs = questions.filter(function (q) { return Number(q.track_id) === Number(t.id); });
      var e = earned.filter(function (x) { return Number(x.track_id) === Number(t.id); });
      return {
        id: Number(t.id), slug: t.slug, title: t.title, icon: t.icon,
        question_count: qs.length, mastered_count: e.length,
        earned_points: e.reduce(function (s, x) { return s + Number(x.points); }, 0),
        available_points: qs.reduce(function (s, q) { return s + Number(q.points); }, 0)
      };
    });

    var attempts = findAll_('attempts', function (a) { return Number(a.user_id) === user.id && a.finished_at; })
      .sort(function (a, b) { return String(a.finished_at) < String(b.finished_at) ? 1 : -1; })
      .slice(0, 20)
      .map(function (a) {
        var title = (findOne_('tracks', function (t) { return Number(t.id) === Number(a.track_id); }) || { row: {} }).row.title || '';
        return {
          id: Number(a.id), track_id: Number(a.track_id), track_title: title,
          started_at: a.started_at, finished_at: a.finished_at,
          score: Number(a.score), max_score: Number(a.max_score), passed: Number(a.passed)
        };
      });

    var ledger = findAll_('points_ledger', function (l) { return Number(l.user_id) === user.id; })
      .sort(function (a, b) { return String(a.created_at) < String(b.created_at) ? 1 : -1; })
      .slice(0, 30)
      .map(function (l) {
        var title = l.track_id ? (findOne_('tracks', function (t) { return Number(t.id) === Number(l.track_id); }) || { row: {} }).row.title || null : null;
        return {
          id: Number(l.id), points: Number(l.points), reason: l.reason,
          created_at: l.created_at, track_title: title
        };
      });

    return ok_({ user: user, tracks: trackSummaries, attempts: attempts, ledger: ledger });
  },

  'admin.questions': function (p) {
    requireAdmin_(p);
    var trackId = p.trackId ? Number(p.trackId) : null;
    var qs = allRows_('questions');
    if (trackId != null) qs = qs.filter(function (q) { return Number(q.track_id) === trackId; });
    var tracks = allRows_('tracks');
    var tMap = {};
    tracks.forEach(function (t) { tMap[Number(t.id)] = t; });
    qs.sort(function (a, b) {
      var ta = tMap[Number(a.track_id)] || {}; var tb = tMap[Number(b.track_id)] || {};
      return (Number(ta.sort_order) || 0) - (Number(tb.sort_order) || 0)
        || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
        || Number(a.id) - Number(b.id);
    });
    var withOptions = qs.map(function (q) {
      var opts = findAll_('options', function (o) { return Number(o.question_id) === Number(q.id); })
        .sort(function (a, b) { return Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id); });
      var t = tMap[Number(q.track_id)] || {};
      return Object.assign({}, q, {
        id: Number(q.id), points: Number(q.points),
        options: opts.map(function (o) { return { id: Number(o.id), text: o.text, is_correct: Number(o.is_correct), sort_order: Number(o.sort_order) }; }),
        track_title: t.title, track_slug: t.slug
      });
    });
    return ok_({
      tracks: tracks.sort(function (a, b) { return Number(a.sort_order) - Number(b.sort_order); })
        .map(function (t) { return { id: Number(t.id), slug: t.slug, title: t.title }; }),
      questions: withOptions
    });
  },

  'admin.addQuestion': function (p) {
    requireAdmin_(p);
    var trackId = Number(p.trackId);
    var text = String(p.text || '').trim();
    var type = p.type === 'multi' ? 'multi' : 'single';
    var difficulty = (['easy','medium','hard'].indexOf(p.difficulty) >= 0) ? p.difficulty : 'medium';
    var points = Math.max(1, Number(p.points) || 10);
    var explanation = String(p.explanation || '').trim() || '';
    var options = Array.isArray(p.options) ? p.options : [];

    if (!trackId || !text) return err_('Track and question text are required.');
    if (options.length < 2) return err_('Add at least two options.');
    var correctCount = options.filter(function (o) { return o && o.correct; }).length;
    if (correctCount < 1) return err_('Mark at least one correct option.');
    if (type === 'single' && correctCount !== 1) return err_('Single-choice questions need exactly one correct option.');

    var siblings = findAll_('questions', function (q) { return Number(q.track_id) === trackId; });
    var maxOrder = siblings.reduce(function (m, q) { return Math.max(m, Number(q.sort_order) || 0); }, 0);
    var qid = nextId_('questions');
    append_('questions', {
      id: qid, track_id: trackId, text: text, type: type, difficulty: difficulty,
      points: points, explanation: explanation, sort_order: maxOrder + 1
    });
    options.forEach(function (opt, i) {
      var optText = String(opt.text || '').trim();
      if (!optText) return;
      append_('options', {
        id: nextId_('options'), question_id: qid, text: optText,
        is_correct: opt.correct ? 1 : 0, sort_order: i + 1
      });
    });
    return ok_({ id: qid });
  },

  'admin.adjustPoints': function (p) {
    requireAdmin_(p);
    var userId = Number(p.userId);
    var points = Number(p.points);
    var reason = String(p.reason || '').trim() || 'admin_adjustment';
    var trackId = p.trackId ? Number(p.trackId) : '';
    if (!userId || !isFinite(points) || points === 0) return err_('userId and non-zero points are required.');
    if (!findOne_('users', function (u) { return Number(u.id) === userId; })) return err_('User not found.', 404);
    append_('points_ledger', {
      id: nextId_('points_ledger'),
      user_id: userId, track_id: trackId, attempt_id: '', question_id: '',
      points: points, reason: reason, created_at: nowIso_()
    });
    return ok_({});
  },

  'admin.users': function (p) {
    requireAdmin_(p);
    var users = allRows_('users').map(function (u) {
      var t = userTotals_(Number(u.id));
      return {
        id: Number(u.id), name: u.name, email: u.email, role: u.role,
        total_points: t.total_points, questions_mastered: t.questions_mastered,
        created_at: u.created_at
      };
    }).sort(function (a, b) { return b.total_points - a.total_points || String(a.name).localeCompare(String(b.name)); });
    return ok_({ users: users });
  }
};

/**
 * One-off utility you can run from the Apps Script editor
 *   (Run → select "resetDatabase" → Run)
 * to wipe the backing spreadsheet and start clean. Useful after schema
 * changes. Also clears the SHEET_ID so the next request creates a fresh one.
 */
function resetDatabase() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* ignore */ }
  }
  PropertiesService.getScriptProperties().deleteProperty('SHEET_ID');
  console.log('Database reset. Next request will create a fresh spreadsheet.');
}
