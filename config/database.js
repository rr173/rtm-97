const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', 'data', 'formula.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function serialize(fn) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      fn().then(resolve).catch(reject);
    });
  });
}

function beginTransaction() {
  return new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION', function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function commit() {
  return new Promise((resolve, reject) => {
    db.run('COMMIT', function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function rollback() {
  return new Promise((resolve, reject) => {
    db.run('ROLLBACK', function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  db,
  run,
  get,
  all,
  exec,
  serialize,
  beginTransaction,
  commit,
  rollback
};
