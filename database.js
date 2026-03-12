const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'journal.db');

let db;
try {
  db = new Database(DB_PATH);
  console.log('✅ Connected to SQLite database');
  initializeDatabase();
} catch (err) {
  console.error('❌ Error opening database:', err.message);
  process.exit(1);
}

function initializeDatabase() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        ambience TEXT NOT NULL,
        text TEXT NOT NULL,
        emotion TEXT,
        keywords TEXT,
        summary TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Journal entries table ready');
  } catch (err) {
    console.error('❌ Error creating table:', err.message);
  }
}

// Promisified wrapper for better-sqlite3 (synchronous API)
const dbAsync = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = db.prepare(sql);
        const result = stmt.run(...params);
        resolve({ id: result.lastInsertRowid, changes: result.changes });
      } catch (err) {
        reject(err);
      }
    });
  },
  
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...params);
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    });
  },
  
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = db.prepare(sql);
        const row = stmt.get(...params);
        resolve(row);
      } catch (err) {
        reject(err);
      }
    });
  }
};

module.exports = { db, dbAsync };