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
`);

// Prepared statements
const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (id, username, first_name, joined_at, last_active)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
`);
const updateUser = db.prepare(`
  UPDATE users SET gender=?, age=?, pregnancy_status=?, goal=?, is_pro=?,
  tz_offset=?, lang=?, analysis_count=?, chat_count=?, last_active=datetime('now') WHERE id=?
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

module.exports = {
  db,
  getUser: (id) => getUser.get(id),
  ensureUser: (id, username, firstName) => {
    insertUser.run(id, username || null, firstName || null);
    return getUser.get(id);
  },
  updateUser: (user) => {
    updateUser.run(user.gender, user.age, user.pregnancy_status, user.goal,
      user.is_pro ? 1 : 0, user.tz_offset || 0, user.lang || 'en', user.analysis_count, user.chat_count, user.id);
  },
  addSymptom: (userId, text) => insertSymptom.run(userId, text),
  getSymptoms: (userId) => getSymptoms.all(userId),
  logEvent: (userId, event, details) => logActivity.run(userId, event, details || ''),
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
