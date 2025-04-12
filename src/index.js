const fs = require('fs')
const config =  require('./config')
const image_upload = require('./upload')
const path = require('path')

const db = require('./db');
const bcrypt = require('bcrypt');

const jwt = require('jsonwebtoken')
const bodyParser = require('body-parser');

const http = require('http')
const express = require('express');
const app = express()

const server = http.Server(app);
const io = require('socket.io')(server);
db.setIo(io);

app.use(bodyParser.json());
app.use('/uploads', express.static(config.UPLOADS_DIR_PATH));
app.use('/docs', express.static('docs'))

server.listen(
    config.PORT,
    () => {
        console.log(`REST API & socket.io running on ${config.BASE_URL}`);
        console.log(`REST API docs served on ${config.BASE_URL}docs/`);
    }
);

function AuthSocket(token)
{
    if (!token) return null;
    try {
        let user = jwt.verify(token, config.JWT_SECRET);
        const exists = db.users.exists(user.user_id);
        if (!exists) return null;
        return user;
    } catch (err) {
        return null;
    }
}

function Auth(req, res, next)
{
    const token = req.headers['authorization'];
    if (!token) return res.status(401).send({error: "No auth token provided"});

    jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).send({error: 'Invalid or expired token'});
        const exists = db.users.exists(decoded.user_id);
        if (!exists) return res.status(403).send({error: 'User no longer exists'});
        req.user_id =  decoded.user_id;
        req.login = decoded.login;
        next();
    });
}

app.get('/sync/socket', (req, res) => {
    return res.status(200).send({message: "Okay"});
});

// Tries to register user, fails if login is already in use
app.post('/user/register', async (req, res) => {
    if (!req.body) return res.status(400).send({error: 'Invalid request'});

    if (!validate(req.body, validation_schema_user)) return res.status(400).json({error: 'Missing required fields: login and/or password'});
    const {login, password} = req.body;

    try {
        const hash = await bcrypt.hash(password, config.JWT_SALTROUNDS);
        const user = db.users.get_user_by_login(login);
        if (user) return res.status(409).send({error: 'User already registered under that login'});
        db.users.insert(login, hash);
        return res.status(200).send({message: "Registered successfully"});
    } catch (err) {
        console.error(err);
        return res.status(500).send({error: 'Internal server error'});
    }
});

// Tries to login user, fails with incorrect credentials and returns a login token
app.post('/user/login', async (req, res) => {
    if (!req.body) return res.status(400).json({error: 'Invalid request'});

    if (!validate(req.body, validation_schema_user)) return res.status(400).json({error: 'Missing required fields: login and/or password'});
    const {login, password} = req.body;

    // Get user by login from db
    const user = db.users.get_user_by_login(login);
    if (!user) return res.status(400).json({error: 'Invalid login credentials'});
    
    // Check password hash
    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(400).json({error: 'Invalid login credentials'});
    
    // Generate JWT headache
    const token = jwt.sign(
        { user_id: user.id, login: user.login },
        config.JWT_SECRET,
        { expiresIn: '1h' }
    );

    return res.status(200).json({
        token: token
    });
});

// Creates new list
app.post('/list', Auth, image_upload.upload.single('image'), image_upload.handleUploadError, (req, res) => {
    if (!req.file) return res.status(400).send({error: "Image upload failed or invalid file type"});
    const {name} = req.body
    if (!name) return res.status(400).send({error: "Missing list name"});

    const result = db.lists.insert(req.user_id, name, req.file.filename)
    const list = db.lists.get(result.lastInsertRowid)

    return res.status(200).json(list);
});

// Gets all lists that are available to user
app.get('/list', Auth, (req, res) => {
    const lists = db.lists.get_lists_accessed_by_user(req.user_id);
    if (!lists) return res.status(200).json([]);
    res.status(200).json({lists: lists});
});

// Gets available list by ID
app.get('/list/:id', Auth, (req, res) => {
    const list_id = req.params.id;
    const has_access = db.lists.has_user_access_to_list(req.user_id, list_id);
    if (!has_access) return res.status(401).send({error: "Access denied"});

    const list = db.lists.get(list_id);

    return res.status(200).json(list);
});

// Gets the background image file
app.get('/list/:id/image', Auth, (req, res) => {
    const list_id = req.params.id;
    const has_access = db.lists.has_user_access_to_list(req.user_id, list_id);
    if (!has_access) return res.status(401).send({error: "Access denied"});
    
    const list = db.lists.get(list_id);
    const file_on_disk = path.join(config.UPLOADS_DIR_PATH, list.image_name);
    res.status(200).sendFile(file_on_disk);
});

// Deletes owned list or unsubscribes from a shared list
app.delete('/list/:id', Auth, (req, res) => {
    const list_id = req.params.id;
    const has_access = db.lists.has_user_access_to_list(req.user_id, list_id);
    if (!has_access) return res.status(401).send({error: "Access denied"});

    const owns_list = db.lists.owns_list(req.user_id, list_id);
    if (owns_list)
    {
        // Make sure to delete the image file
        const list = db.lists.get(list_id);
        const old_image_path = path.join(config.UPLOADS_DIR_PATH, list.image_name);
        fs.unlinkSync(old_image_path);
        db.lists.delete(list_id);
        return res.status(200).send({message: "List deleted successfully"})
    }
    else
    {
        // Subcribed client is deleting list, remove him from shared_with
        db.shared_with.delete(req.user_id, list_id);
        return res.status(200).send({message: "Unsubscribed from list"})
    }
});

// Updates owned list
app.patch('/list/:id', Auth, image_upload.upload.single('image'), image_upload.handleUploadError, (req, res) => {
    const list_id = req.params.id;
    const has_access = db.lists.owns_list(req.user_id, list_id);
    if (!has_access) { if (req.file) fs.unlinkSync(req.file.path); return res.status(401).send({error: "Access denied"}); }
    
    const { name } = req.body;
    if (!name) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).send({error: "Missing list name"}); }
    
    if (!req.file) return res.status(400).send({error: "Image upload failed or invalid file type"});
    
    // Make sure to delete the image file
    const list = db.lists.get(list_id);
    const old_image_path = path.join(config.UPLOADS_DIR_PATH, list.image_name);
    fs.unlinkSync(old_image_path);
    db.lists.update(list_id, name, req.file.filename);
    return res.status(200).send({message: "Update success"})
});

// Gets items from accessed list
app.get('/list/:id/items', Auth, (req, res) => {
    const list_id = req.params.id;
    let items;
    try { items = db.lists.get_list_items(req.user_id, list_id); }
    catch (err) {
        if (err.code === 'FORBIDDEN') return res.status(401).send({error: 'Access denied'});
        return res.status(500).send({error: 'Internal server error'});
    }
    return res.status(200).json({items: items});
});

// Inserts items into accessed list
app.post('/list/:id/items', Auth, (req, res) => {
    const list_id = req.params.id;
    const has_access = db.lists.has_user_access_to_list(req.user_id, list_id);
    if (!has_access) return res.status(401).send({error: 'Access denied'});

    let items;
    try { items = req.body.items }
    catch (err) { return res.status(400).send({error: 'Missing items array'}); }
    if (items.length == 0) return res.status(400).send({error: 'Missing item values'});
    
    // Validate each item
    for (let i = 0; i < items.length; i++)
    {
        let element = items[i];
        if (!element.name instanceof String || !element.description instanceof String || !element.count instanceof Number || Math.floor(element.count) <= 0)
            { return res.status(400).send({error: 'Invalid item format'}); }
        element.count = Math.floor(element.count); // Just in case
    }
    
    db.lists.insert_items(list_id, items);

    return res.status(200).send({ message: `Inserted ${items.length} items`});
});

// Expects a collection of user items which the server merges according to timestamps
// Server returns a collection of items for client to cache
// Expects {updated_at: list timestamp, items: [ item ]}
// The idea is so simple, yet difficult to code.. why?
app.post('/sync/list/:id', Auth, (req, res) => {
    // Get API items
    const list_id = req.params.id;
    const has_access = db.lists.has_user_access_to_list(req.user_id, list_id);
    if (!has_access) return res.status(401).send({error: 'Access denied'});

    const { updated_at, items } = req.body;
    // Validate each lists item
    if (!updated_at || !items || !Array.isArray(items)) return res.status(400).send({error: 'Incorrect format'});
    for (let i = 0; i < items.length; i++)
    {
        let element = items[i];
        if (!validate(element, validation_schema_item_sync)) return res.status(400).send({error: 'Invalid item format'});
        // string updated_at is magical and just works.. okay, please don't abuse my API :/
    }

    // Get list
    const client_list_updated_at = updated_at;
    let list;
    let list_items;
    try
    {
        list = db.lists.get_list_by_id(req.user_id, list_id);
        list_items = db.lists.get_list_items(req.user_id, list_id);
    }
    catch (err)
    {
        if (err.code === 'FORBIDDEN') return res.status(403).send({error: 'Access denied'});
        else if (err.code === 'NOT_FOUND') return res.status(500).send({error: 'List not found'});
        console.log(err);
        return res.status(500).send({error: 'Internal server error'});
    }

    // Sync items.. yay
    const client_items = items;
    const server_items = list_items
    let server_items_to_post = []
    let server_items_to_delete = []
    let server_items_to_update = []
    for (let index = 0; index < client_items.length; index++) {
        const item = client_items[index];      
        const server_item = server_items.find((element) => element.id === item.id);

        if (!server_item) {
            if (item.deleted === 1)
                continue; // Client deleted item, but it no longer exists anyways.. skip
            else if (item.updated_at > list.updated_at)
                server_items_to_post.push(item); // Item doesn't exist and was created by client
            else if (item.updated_at < list.updated_at)
                continue; // Item was already deleted by someone before
        }
        else {
            if (item.deleted === 1)
                server_items_to_delete.push(item.id) // Item was deleted by client
            else if (item.updated_at > server_item.updated_at)
                server_items_to_update.push(item); // Item exists, and has been edited by client
        }
    }

    // console.log('insert new', server_items_to_post)
    // console.log('delete', server_items_to_delete)
    // console.log('update', server_items_to_update)

    db.lists.insert_items_realized(list_id, server_items_to_post);
    db.lists.delete_items_by_ids(server_items_to_delete);
    db.lists.update_items(server_items_to_update);
    db.lists.update_timestamp(list_id);
    
    const updated_items = db.lists.get_list_items(req.user_id, list_id);
    
    return res.status(200).json(updated_items);
});

// Gets the server item on individual basis
app.get('/items/:id', Auth, (req, res) => {
    const item_id = req.params.id;
    const has_access = db.items.has_access(req.user_id, item_id);
    if (!has_access) return res.status(401).send({error: 'Access denied'});

    const result = db.items.get(item_id);
    return res.status(200).json(result);
});

// Updates the server item on individual basis
// Expects the full item data type
app.patch('/items/:id', Auth, (req, res) => {
    const item_id = req.params.id;
    const has_access = db.items.has_access(req.user_id, item_id);
    if (!has_access) return res.status(401).send({error: 'Access denied'});
    const item = req.body;
    if (!validate(item, validation_schema_item)) return res.status(400).send({error: 'Invalid format'});

    const serv_item = db.items.get(item_id);
    const result = db.items.update(item);
    db.lists.update_timestamp(serv_item.list_id);
    return res.status(200).send({message: "Operation successfull"});
});

// Deletes the server item on individual basis
app.delete('/items/:id', Auth, (req, res) => {
    const item_id = req.params.id;
    const has_access = db.items.has_access(req.user_id, item_id);
    if (!has_access) return res.status(401).send({error: 'Access denied'});

    const serv_item = db.items.get(item_id);
    const result = db.items.delete(item_id);
    db.lists.update_timestamp(serv_item.list_id);
    return res.status(200).send({message: "Operation successfull"});
});

// Register sharing of list to auth user from share_code and return list info
app.post('/list/subscribe/:code', Auth, (req, res) => {
    const share_code = req.params.code;
    const list = db.lists.get_list_by_share_code(share_code);
    if (!list) return res.status(400).send({error: "Invalid share code"});
    const has_access = db.lists.has_user_access_to_list(req.user_id, list.id);
    if (has_access) return res.status(400).json({error: "Cannot subscribe to an already accessed list"});
    db.shared_with.insert(req.user_id, list.id);
    return res.status(200).json(list);
});

/* Real time updates */
io.on('connection', (socket) => {
    const auth_token = socket.handshake.auth?.token;
    
    const user = AuthSocket(auth_token);
    if (!user) return socket.disconnect(true);
    socket.emit('authenticated');
    
    console.log(`Client connected: `);
    socket.on('subscribe', (list_ids) => {
        for (const list_id of list_ids) {
            const has_access = db.lists.has_user_access_to_list(user.user_id, list_id);
            if (!has_access) return;
            socket.join(list_id);
            console.log(`Client listening to list ${list_id}`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: `);
    });
});

/* Validation schemas */
const { z } = require('zod')
const validation_schema_item_sync = z.object({
    id: z.string().uuid(),
    list_id: z.number().int(),
    name: z.string(),
    description: z.string(),
    count: z.number().int(),
    updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    checked_off: z.number().int().min(0).max(1),
    deleted: z.number().int().min(0).max(1)
});

const validation_schema_item = z.object({
    id: z.string().uuid(),
    list_id: z.number().int(),
    name: z.string(),
    description: z.string(),
    count: z.number().int(),
    updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    checked_off: z.number().int().min(0).max(1)
});

const validation_schema_user = z.object({
    login: z.string(),
    password: z.string()
});

function validate(data, schema) {
    try {
        const validatedItem = schema.parse(data);
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = io;