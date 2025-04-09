const config = require('./config')

const Database = require('better-sqlite3');
const { userInfo } = require('os');
const path = require('path');

const {nanoid} = require('nanoid');
const db = new Database(config.DB_PATH);

function db_init() {
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
            image_path VARCHAR,
            share_code VARCHAR
        )
    `).run();
    db.prepare(`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id INTEGER,
            name VARCHAR,
            description VARCHAR,
            count INTEGER,
            updated_at TIMESTAMP
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

const users = {
    get_user_by_login(login)
    {
        const stmt = db.prepare('SELECT id, login, password FROM users WHERE login = ?');
        const result = stmt.get(login);
        return result;
    },
    insert(login, hashed_password)
    {
        db.prepare('INSERT INTO users (login, password) VALUES (?, ?);').run(login, hashed_password);
    },
    exists(user_id)
    {
        return db.prepare('SELECT 1 FROM users WHERE id = ?').get(user_id) ? true : false;
    }
};

const lists = {
    has_user_access_to_list(user_id, list_id)
    {
        const stmt_has_access = db.prepare(`
            SELECT 1 FROM lists WHERE id = ? AND owner_id = ?
            UNION
            SELECT 1 FROM shared_with WHERE list_id = ? AND user_id = ?
        `);
        const has_access = stmt_has_access.get(list_id, user_id, list_id, user_id);
        return has_access ? true : false;
    },
    owns_list(user_id, list_id)
    {
        const stmt = db.prepare(`SELECT 1 FROM lists WHERE id = ? AND owner_id = ?`);
        const owns = stmt.get(list_id, user_id);
        return owns ? true : false;
    },
    get_list_by_id(user_id, list_id)
    {
        const has_access = lists.has_user_access_to_list(user_id, list_id);
        if (!has_access) {
            const err = new Error("Access denied to list");
            err.code = 'FORBIDDEN';
            throw err;
        }
    
        const stmt_list = db.prepare(`
        SELECT * FROM lists
        WHERE id = ?
        `);
        const list = stmt_list.get(list_id);
        if (!list)
            {
                const err = new Error("List not found");
                err.code = 'NOT_FOUND';
                throw err;
            }
            
        return list;
    },
    get_lists_accessed_by_user(user_id)
    {
        const stmt = db.prepare(`
            SELECT list.id, list.owner_id, list.name, list.updated_at, list.image_path, list.share_code
            FROM shared_with
            JOIN lists AS list ON list_id = list.id AND user_id = ?
            UNION
            SELECT id, owner_id, name, updated_at, image_path, share_code
            FROM lists
            WHERE owner_id = ?;
        `);
        const lists = stmt.all(user_id, user_id)
        return lists;
    },
    insert(user_id, name, filename)
    {
        let share_code;
        let uniqueness = false;
        while (!uniqueness)
        {
            share_code = nanoid();
            const stmt = db.prepare(`SELECT 1 FROM lists WHERE share_code = ?`)
            uniqueness = !stmt.get(share_code)
        }
        const stmt = db.prepare('INSERT INTO lists (owner_id, name, updated_at, image_path, share_code) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)')
        const result = stmt.run(user_id, name, filename, share_code);
        return result;
    },
    get_list_items(user_id, list_id)
    {
        const has_access = lists.has_user_access_to_list(user_id, list_id);
        if (!has_access) {
            const err = new Error("Access denied to list");
            err.code = 'FORBIDDEN';
            throw err;
        };
        const stmt = db.prepare(`SELECT * FROM items WHERE list_id = ?`);
        const items = stmt.all(list_id);
        if (!items) items = []
        return items;
    },
    insert_items(user_id, list_id, items)
    {
        const has_access = lists.has_user_access_to_list(user_id, list_id);
        if (!has_access) {
            const err = new Error("Access denied to list");
            err.code = 'FORBIDDEN';
            throw err;
        };

        const stmt = db.prepare(`
            INSERT INTO items (list_id, name, description, count, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        items.forEach(element => {
            stmt.run(list_id, element.name, element.description, element.count);
        });
    },
    get(list_id)
    {
        const stmt = db.prepare(`SELECT * FROM lists WHERE id = ?`);
        return stmt.get(list_id);
    },
    update(list_id, name, filename)
    {
        const stmt = db.prepare(`UPDATE lists SET name = ?, image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        stmt.run(name, filename, list_id);
    },
    delete(list_id)
    {
        let stmt = db.prepare(`DELETE FROM lists WHERE id = ?`);
        stmt.run(list_id);
        stmt = db.prepare('DELETE FROM items WHERE list_id = ?');
        stmt.run(list_id);
        stmt = db.prepare(`DELETE FROM shared_with WHERE list_id = ?`);
        stmt.run(list_id);
    },
    get_list_by_share_code(share_code)
    {
        const stmt = db.prepare(`SELECT * FROM lists WHERE share_code = ?`);
        const result = stmt.get(share_code);
        return result ? result : null
    }
};

const shared_with = {
    exists(user_id, list_id)
    {
        const stmt = db.prepare(`SELECT 1 FROM shared_with WHERE user_id = ? AND list_id = ?`);
        const result = stmt.get(user_id, list_id);
        return result ? true : false;
    },
    insert(user_id, list_id)
    {
        const exists = shared_with.exists(user_id, list_id);
        if (exists) return;
        const stmt = db.prepare(`INSERT INTO shared_with (user_id, list_id) VALUES (?, ?)`);
        const result = stmt.run(user_id, list_id);
    }
};

db_init();

module.exports = {
    db,
    lists, users, shared_with
}