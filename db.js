const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'metabolic.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    gender TEXT,
    age INTEGER,
    height INTEGER,
    weight REAL,
    activity_level TEXT,
    diet_restrictions TEXT,
    pregnancy_status TEXT,
    goal TEXT,
    is_pro INTEGER DEFAULT 0,
    tz_offset INTEGER DEFAULT 0,
    lang TEXT DEFAULT 'en',
    analysis_count INTEGER DEFAULT 0,
    chat_count INTEGER DEFAULT 0,
    joined_at TEXT DEFAULT (datetime('now')),
    last_active TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS symptoms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    text TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    event TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS food_diary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    description TEXT,
    calories INTEGER,
    protein REAL,
    carbs REAL,
    fat REAL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS detox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    day INTEGER DEFAULT 1,
    started_at TEXT DEFAULT (datetime('now')),
    completed_days TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migrate: add new columns if missing
try { db.exec('ALTER TABLE users ADD COLUMN height INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN weight REAL'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN activity_level TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN diet_restrictions TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN trial_expires INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN trial_used INTEGER DEFAULT 0'); } catch(e) {}

// Prepared statements
const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (id, username, first_name, joined_at, last_active)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
`);
const updateUser = db.prepare(`
  UPDATE users SET gender=?, age=?, height=?, weight=?, activity_level=?, diet_restrictions=?, pregnancy_status=?, goal=?, is_pro=?,
  tz_offset=?, lang=?, analysis_count=?, chat_count=?, trial_expires=?, referral_code=?, referred_by=?, trial_used=?, last_active=datetime('now') WHERE id=?
`);
const insertSymptom = db.prepare('INSERT INTO symptoms (user_id, text) VALUES (?, ?)');
const getSymptoms = db.prepare('SELECT * FROM symptoms WHERE user_id = ? ORDER BY created_at DESC LIMIT 20');
const logActivity = db.prepare('INSERT INTO activity_log (user_id, event, details) VALUES (?, ?, ?)');
const countUsers = db.prepare('SELECT COUNT(*) as count FROM users');
const countPro = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_pro = 1');
const totalAnalyses = db.prepare('SELECT SUM(analysis_count) as total FROM users');
const totalChats = db.prepare('SELECT SUM(chat_count) as total FROM users');
const recentUsers = db.prepare('SELECT * FROM users ORDER BY joined_at DESC LIMIT 10');
const todayUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE joined_at >= date('now')");
const todayActivity = db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE created_at >= date('now')");

// Food diary statements
const insertFoodEntry = db.prepare('INSERT INTO food_diary (user_id, description, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?)');
const getTodayFood = db.prepare("SELECT * FROM food_diary WHERE user_id = ? AND created_at >= date('now') ORDER BY created_at DESC");
const getRecentFood = db.prepare("SELECT * FROM food_diary WHERE user_id = ? ORDER BY created_at DESC LIMIT 30");
const getUsersWithFoodToday = db.prepare("SELECT DISTINCT user_id FROM food_diary WHERE created_at >= date('now')");

// Detox statements
const getDetox = db.prepare('SELECT * FROM detox WHERE user_id = ?');
const upsertDetox = db.prepare(`INSERT INTO detox (user_id, day, started_at, completed_days) VALUES (?, ?, datetime('now'), '')
  ON CONFLICT(user_id) DO UPDATE SET day=?, started_at=datetime('now'), completed_days=''`);
const updateDetox = db.prepare('UPDATE detox SET day=?, completed_days=? WHERE user_id=?');

// Referral
const getUserByReferral = db.prepare('SELECT * FROM users WHERE referral_code = ?');
const countReferrals = db.prepare('SELECT COUNT(*) as count FROM users WHERE referred_by = ?');

module.exports = {
  db,
  getUser: (id) => getUser.get(id),
  ensureUser: (id, username, firstName) => {
    insertUser.run(id, username || null, firstName || null);
    return getUser.get(id);
  },
  updateUser: (user) => {
    updateUser.run(user.gender, user.age, user.height || null, user.weight || null, user.activity_level || null,
      user.diet_restrictions || null, user.pregnancy_status, user.goal, user.is_pro ? 1 : 0, user.tz_offset || 0,
      user.lang || 'en', user.analysis_count, user.chat_count, user.trial_expires || 0,
      user.referral_code || null, user.referred_by || 0, user.trial_used || 0, user.id);
  },
  addSymptom: (userId, text) => insertSymptom.run(userId, text),
  getSymptoms: (userId) => getSymptoms.all(userId),
  logEvent: (userId, event, details) => logActivity.run(userId, event, details || ''),
  // Food diary
  addFoodEntry: (userId, desc, cal, protein, carbs, fat) => insertFoodEntry.run(userId, desc, cal, protein, carbs, fat),
  getTodayFood: (userId) => getTodayFood.all(userId),
  getRecentFood: (userId) => getRecentFood.all(userId),
  getUsersWithFoodToday: () => getUsersWithFoodToday.all(),
  // Detox
  getDetox: (userId) => getDetox.get(userId),
  startDetox: (userId) => upsertDetox.run(userId, 1, 1),
  updateDetox: (userId, day, completedDays) => updateDetox.run(day, completedDays, userId),
  // Referral
  getUserByReferral: (code) => getUserByReferral.get(code),
  countReferrals: (userId) => countReferrals.get(userId).count,
  stats: () => ({
    totalUsers: countUsers.get().count,
    proUsers: countPro.get().count,
    totalAnalyses: totalAnalyses.get().total || 0,
    totalChats: totalChats.get().total || 0,
    todayUsers: todayUsers.get().count,
    todayActivity: todayActivity.get().count,
    recentUsers: recentUsers.all()
  })
};
