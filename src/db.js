const config = require('./config')

const Database = require('better-sqlite3');

const { v4: uuidv4 } = require('uuid')
const { nanoid } = require('nanoid');
const db = new Database(config.DB_PATH);

let io = null; // The socket.io .. socket? where we emit change events

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
            image_name VARCHAR,
            share_code VARCHAR
        )
    `).run();
    db.prepare(`
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            list_id INTEGER,
            name VARCHAR,
            description VARCHAR,
            count INTEGER,
            checked_off BOOLEAN,
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
        const stmt = db.prepare('INSERT INTO users (login, password) VALUES (?, ?);')
        const result = stmt.run(login, hashed_password);
        return result;
    },
    exists(user_id)
    {
        const stmt = db.prepare('SELECT 1 FROM users WHERE id = ?');
        const result = stmt.get(user_id) ? true : false;
        return result;
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
            SELECT list.id, list.owner_id, list.name, list.updated_at, list.image_name, list.share_code
            FROM shared_with
            JOIN lists AS list ON list_id = list.id AND user_id = ?
            UNION
            SELECT id, owner_id, name, updated_at, image_name, share_code
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
        while (!uniqueness) {
            share_code = nanoid();
            const stmt = db.prepare(`SELECT 1 FROM lists WHERE share_code = ?`)
            uniqueness = !stmt.get(share_code)
        }
        const stmt = db.prepare('INSERT INTO lists (owner_id, name, updated_at, image_name, share_code) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)')
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
    insert_items(list_id, items_arr)
    {
        if (items_arr.length === 0) return;

        items_arr.forEach(item => {
            items.insert_new(list_id, item.name, item.description, item.count || 1, item.checked_off || 0)
        });
        lists.update_timestamp(list_id);
    },
    insert_items_realized(list_id, items_arr)
    {
        if (items_arr.length === 0) return;

        items_arr.forEach(item => {
            items.insert_realised(item);
        });
        lists.update_timestamp(list_id);
    },
    get(list_id)
    {
        const stmt = db.prepare(`SELECT * FROM lists WHERE id = ?`);
        const result = stmt.get(list_id);
        return result;
    },
    update(list_id, name, filename)
    {
        const stmt = db.prepare(`UPDATE lists SET name = ?, image_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        const result = stmt.run(name, filename, list_id);
        
        const list = lists.get(list_id);
        ListUpdate(list);
        return result;
    },
    delete(list_id)
    {
        const ref_list = lists.get(list_id);
        
        // This should be synced
        let stmt = db.prepare(`DELETE FROM lists WHERE id = ?`);
        stmt.run(list_id);
        
        ListDelete(ref_list);
        
        // This has no reason to be synced as this is a cascade
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
    },
    delete_items_by_ids(item_ids)
    {
        if (item_ids.length === 0) return;

        item_ids.forEach(item_id => {
            items.delete(item_id);
        });
    },
    update_items(items_arr)
    {
        if (items_arr.length === 0) return;
        items_arr.forEach(item => {
            items.update(item)
        });
    },
    update_timestamp(list_id)
    {
        const stmt = db.prepare(`UPDATE lists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        const result = stmt.run(list_id);
    },
    get_users_with_access(list_id) {
        const stmt = db.prepare(`
            SELECT users.id, users.login FROM lists JOIN users ON lists.owner_id = users.id WHERE lists.id = ?
            UNION
            SELECT users.id, users.login FROM shared_with JOIN users ON shared_with.user_id = users.id WHERE list_id = ?;
        `);
        const result = stmt.all(list_id, list_id);
        return result ? result : [];
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
    },
    delete(user_id, list_id)
    {
        const stmt = db.prepare(`DELETE FROM shared_with WHERE user_id = ? AND list_id = ?`);
        const result =  stmt.run(user_id, list_id);
        return result;
    }
};

const items = {
    has_access(user_id, item_id) {
        const list_id_stmt = db.prepare(`SELECT list_id FROM items WHERE id = ?`);
        const result_list_id = list_id_stmt.get(item_id);
        if (!result_list_id) return false; // Item doesn't exist
        const { list_id } = result_list_id;

        const list_access = lists.has_user_access_to_list(user_id, list_id);
        if (!list_access) return false; //  Doesn't have access to list
        return true;
    },
    get(item_id) {
        const stmt = db.prepare(`SELECT * FROM items WHERE id = ?`);
        const result = stmt.get(item_id);
        return result;
    },
    update(item) {
        const stmt = db.prepare(`UPDATE items SET name = ?, description = ?, count = ?, updated_at = ?, checked_off = ?, list_id = ? WHERE id = ?`);
        const result = stmt.run(item.name, item.description, item.count, item.updated_at, item.checked_off, item.list_id, item.id);

        ItemUpdate(item);
        return result;
    },
    delete(item_id) {
        const item = items.get(item_id)
        const stmt = db.prepare(`DELETE FROM items WHERE id = ?`);
        const result = stmt.run(item_id);
        
        ItemDelete(item);
        return result;
    },
    insert_realised(item) {
        const stmt = db.prepare(`
            INSERT INTO items (id, list_id, name, description, count, updated_at, checked_off)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(item.id, item.list_id, item.name, item.description, item.count, item.updated_at, item.checked_off);

        ItemAdd(item);
        return result;
    },
    insert_new(list_id, name, description, count, checked_off) {
        const stmt = db.prepare(`
            INSERT INTO items (id, list_id, name, description, count, updated_at, checked_off)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        `);
        const uuid = uuidv4();
        const result = stmt.run(uuid, list_id, name, description, count, checked_off);

        ItemAdd(items.get(uuid));
        return result;
    }
}

/* Real-time updates */
function setIo(socketIo)
{
    io = socketIo;
}

function ItemAdd(item) {
    if (!io) return;
    const action = {type: "add", updated_at: item.updated_at, item: item};
    io.to(item.list_id).emit('item-update', action);
}

function ItemUpdate(item) {
    if (!io) return;
    const action = {type: "mod", updated_at: item.updated_at, item: item};
    io.to(item.list_id).emit('item-update', action);
}

function ItemDelete(item) {
    if (!io) return;
    const action = {type: "del", updated_at: item.updated_at, item: item};
    io.to(item.list_id).emit('item-update', action);
}

function ListUpdate(list) {
    if (!io) return;
    const action = {type: "mod", updated_at: list.updated_at, list_id: list.id};
    io.to(list.id).emit('list-update', action);
}

function ListDelete(list) {
    if (!io) return;
    const action = {type: "del", updated_at: list.updated_at, list_id: list.id};
    io.to(list.id).emit('list-update', action);
}

db_init();

module.exports = {
    db,
    lists, users, shared_with, items,
    setIo
}