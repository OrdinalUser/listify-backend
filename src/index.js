const fs = require('fs')
const config =  require('./config')
const image_upload = require('./upload')
const path = require('path')

const db = require('./db');
const bcrypt = require('bcrypt');

const jwt = require('jsonwebtoken')

const express = require('express');
const bodyParser = require('body-parser');
const { timeStamp } = require('console');

const app = express()

app.use(bodyParser.json());
app.use('/uploads', express.static(config.UPLOADS_DIR_PATH));

app.listen(
    config.PORT,
    () => {
        console.log(`REST api running on ${config.BASE_URL}`);
    }
);

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

// Tries to register user, fails if login is already in use
app.post('/user/register', async (req, res) => {
    if (!req.body)
        return res.status(400).send({error: 'Invalid request'});

    const {login, password} = req.body;
    if (!login && !password)
        return res.status(400).send({error: 'Missing login, password'});
    else if (!login)
        return res.status(400).send({error: 'Missing login'});
    else if (!password)
        return res.status(400).send({error: 'Missing password'});

    try
    {
        const hash = await bcrypt.hash(password, config.JWT_SALTROUNDS);
        const user = db.users.get_user_by_login(login);
        if (user) return res.status(409).send({error: 'User already registered under that login'});
        db.users.insert(login, hash);
        return res.status(200).send("Registered successfully");
    } catch (err)
    {
        console.error(err);
        return res.status(500).send({error: 'Internal server error'});
    }
});

// Tries to login user, fails with incorrect credentials and returns a login token
app.post('/user/login', async (req, res) => {
    if (!req.body)
        return res.status(400).json({error: 'Invalid request'});

    const {login, password} = req.body;
    if (!login && !password)
        return res.status(400).json({error: 'Missing login, password'});
    else if (!login)
        return res.status(400).json({error: 'Missing login'});
    else if (!password)
        return res.status(400).json({error: 'Missing password'});

    // Get user by login from db
    const user = db.users.get_user_by_login(login);
    if (!user)
        return res.status(401).json({error: 'Invalid login details'});
    
    // Check password hash
    const match = await bcrypt.compare(password, user.password)
    if (!match)
        return res.status(401).json({error: 'Invalid login details'});
    
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

    return res.status(200).send({
        owner_id: req.user_id,
        list_name: name,
        list_id: result.lastInsertRowid
    })
});

// Gets all lists that are available to user
app.get('/list', Auth, (req, res) => {
    const lists = db.lists.get_lists_accessed_by_user(req.user_id);
    lists.forEach(element => {
        const uri_path = `${config.BASE_URL}${config.UPLOADS_DIR}/${element.image_path}`;
        element.image_path = uri_path;
    });
    if (!lists) return res.status(200).json([]);
    res.status(200).json(lists);
});

// Gets available list by ID
app.get('/list/:id', Auth, (req, res) => {
    const list_id = req.params.id;
    const user_id = req.user_id;

    let list;
    try
    {
        list = db.lists.get_list_by_id(user_id, list_id);
    }
    catch (err)
    {
        if (err.code === 'FORBIDDEN') return res.status(403).send({error: 'Access denied'});
        else if (err.code === 'NOT_FOUND') return res.status(500).send({error: 'List not found'});
        console.log(err);
        return res.status(500).send({error: 'Internal server error'});
    }

    const uri_path = `${config.BASE_URL}${config.UPLOADS_DIR}/${list.image_path}`;
    list.image_path = uri_path;
    return res.status(200).json(list);
});

// Deletes owned list
app.delete('/list/:id', Auth, (req, res) => {
    const list_id = req.params.id;
    const has_access = db.lists.owns_list(req.user_id, list_id);
    if (!has_access) return res.status(403).send({error: "Access denied"});
    
    // Make sure to delete the image file
    const list = db.lists.get(list_id);
    const old_image_path = path.join(config.UPLOADS_DIR_PATH, list.image_path);
    fs.unlinkSync(old_image_path);
    db.lists.delete(list_id);
    return res.status(200).send({message: "Delete success"})
});

// Updates owned list
app.patch('/list/:id', Auth, image_upload.upload.single('image'), image_upload.handleUploadError, (req, res) => {
    const list_id = req.params.id;
    const has_access = db.lists.owns_list(req.user_id, list_id);
    if (!has_access) { if (req.file) fs.unlinkSync(req.file.path); return res.status(403).send({error: "Access denied"}); }
    
    const { name } = req.body;
    if (!name) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).send({error: "Missing list name"}); }
    
    if (!req.file) return res.status(400).send({error: "Image upload failed or invalid file type"});
    
    // Make sure to delete the image file
    const list = db.lists.get(list_id);
    const old_image_path = path.join(config.UPLOADS_DIR_PATH, list.image_path);
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
        if (err.code === 'FORBIDDEN') return res.status(403).send({error: 'Access denied'});
        return res.status(500).send({error: 'Internal server error'});
    }
    return res.status(200).json(items);
});

// Inserts items into accessed list
app.post('/list/:id/items', Auth, (req, res) => {
    const list_id = req.params.id;
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
    
    try { db.lists.insert_items(req.user_id, list_id, items); }
    catch (err) {
        if (err.code === 'FORBIDDEN') return res.status(403).send({error: 'Access denied'});
        console.log(err.message);
        return res.status(500).send({error: 'Internal server error '});
    }

    return res.status(200).send({ message: `Inserted ${items.length} items`});
});

// Register sharing of list to auth user from share_code and return list info
app.post('/list/import', Auth, (req, res) => {
    const {share_code} = req.body;
    if (!share_code) return res.status(400).send({error: "Missing share code"});
    const list = db.lists.get_list_by_share_code(share_code);
    if (!list) return res.status(400).send({error: "Invalid share code"});
    db.shared_with.insert(req.user_id, list.id);
    return res.status(200).json(list);
});

// Returns a collection of which listsids need to be updated by the client
// Expects { lists: [{id: list_id, updated_at: timestamp} ]
app.post('/sync/list', Auth, (req, res) => {
    let lists;
    try { lists = req.body.lists }
    catch (err) { return res.status(400).send({error: 'Missing lists array'}); }
    if (lists.length == 0) return res.status(400).send({error: 'Missing item values'});

    // Validate each lists item
    for (let i = 0; i < lists.length; i++)
    {
        let element = lists[i];
        if (!element.id instanceof Number || !element.updated_at instanceof String)
            { return res.status(400).send({error: 'Invalid item format'}); }
        element.id = Math.floor(element.id); // Just in case
        // string updated_at is magical and just works.. okay, please don't abuse my API :/
    }

    // Compare timestamps
    // User can not create lists locally so this should be doable
    let all_lists = db.lists.get_lists_accessed_by_user(req.user_id);
    let remote_lists = []
    for (let index = 0; index < all_lists.length; index++) {
        const list = all_lists[index];
        const user_list = lists.find(element => element.list_id === list.id)
        if (!user_list) { console.log('user missing list', list.id); remote_lists.push(list.id); }
        else if (list.updated_at !== user_list.updated_at) { console.log(list.updated_at, user_list.updated_at); remote_lists.push(list.id); }
    }
    return res.status(200).json({lists: remote_lists});
});

// Expects a collection of user items which the server merges according to timestamps
// Server returns a collection of items for client to cache
// Expects {updated_at: list timestamp, items: [ item ]}
// The idea is so simple, yet difficult to code.. why?
app.post('/sync/list/:id', Auth, (req, res) => {
    // Get API items
    const list_id = req.params.id;
    const { updated_at, items } = req.body;
    if (!updated_at || !items) return res.status(400).send({error: 'Missing items array'});
    if (items.length == 0) return res.status(400).send({error: 'Missing item values'});

    // Get list
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
    let server_item_ids_to_delete = []
    let server_items_to_update = []
    client_items.forEach(item => {
        const server_item = server_items.find((element) => element.id === item.id);
        if (!server_item)
            if (item.updated_at > list.updated_at)
                server_items_to_post.push(item); // Item doesn't exist and is newer than last known update
            // else  Item doesn't exist, but is older than last update.. possibly checked off by someone else
        else if (item.updated_at > server_item.updated_at)
            server_items_to_update.push(item); // Item exists, and has been edited by client
    });
});

// TODO: Real-time updates / syncing