const config = require('./config')

const Database = require('better-sqlite3')
const path = require('path')

const db = new Database(config.DB_PATH)

function db_init()
{
    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            login VARCHAR,
            password CHAR(60)
        )
    `).run();
    db.prepare(`
        CREATE TABLE IF NOT EXISTS lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER,
            name varchar,
            updated_at TIMESTAMP,
            image_path VARCHAR
        )
    `).run();
    db.prepare(`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id INTEGER,
            name VARCHAR,
            description VARCHAR
        )
    `).run();
    db.prepare(`
        CREATE TABLE IF NOT EXISTS shared_with (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id INTEGER,
            user_id INTEGER
        )
    `).run();
}

db_init();

module.exports = db;