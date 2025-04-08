const config =  require('./config')
const image_upload = require('./upload')
const path = require('path')

const db  = require('./db');
const bcrypt = require('bcrypt');

const jwt = require('jsonwebtoken')

const express = require('express');
const bodyParser = require('body-parser')

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
        const stmt = db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?;');
        const {count} = stmt.get(decoded.user_id);
        if (count > 1) console.log(`There are multiple users with id ${decoded.user_id}`);
        if (count == 0) return res.status(403).send({error: 'User no longer exists'});
        req.user_id =  decoded.user_id;
        req.login = decoded.login;
        next();
    });
}

function registerUser(login, hashed_password)
{
    const stmt = db.prepare('SELECT COUNT(*) AS count FROM users WHERE login = ?;');
    const {count} = stmt.get(login)
    if (count !== 0) return false;
    
    db.prepare('INSERT INTO users (login, password) VALUES (?, ?);').run(login, hashed_password)
    return true;
}

app.post('/register', async (req, res) =>
{
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
        const success = registerUser(login, hash)
        if (success)
            res.status(200).send("Registered successfully");
        else
            res.status(409).send({error: 'User already registered under that login'});
    } catch (err)
    {
        console.error(err);
        res.status(500).send({error: 'Internal server error'});
    }
});

app.post('/login', async (req, res) => {
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
    const stmt = db.prepare('SELECT id, login, password FROM users WHERE login = ?');
    const result = stmt.get(login)
    if (result === undefined)
        return res.status(401).json({error: 'Invalid login details'});
    
    // Check password hash
    const match = await bcrypt.compare(password, result.password)
    if (!match)
        return res.status(401).json({error: 'Invalid login details'});
    
    // Generate JWT headache
    const token = jwt.sign(
        { user_id: result.id, login: result.login },
        config.JWT_SECRET,
        { expiresIn: '1h' }
    );

    return res.status(200).json({
        token: token
    });
});

app.post('/list', Auth, image_upload.upload.single('image'), image_upload.handleUploadError, (req, res) => {
    if (!req.file) return res.status(400).send({error: "Image upload failed or invalid file type"});
    const {name} = req.body
    if (!name) return res.status(400).send({error: "Missing list name"});

    const stmt = db.prepare('INSERT INTO lists (owner_id, name, updated_at, image_path) VALUES (?, ?, CURRENT_TIMESTAMP, ?)')
    const result = stmt.run(req.user_id, name, req.file.filename);

    res.status(200).send({
        owner_id: req.user_id,
        list_name: name,
        list_id: result.lastInsertRowid
    })
});

app.get('/list/:id', Auth, (req, res) => {
    const list_id = req.params.id;

    const stmt = db.prepare('SELECT * FROM lists WHERE id = ?;');
    const list = stmt.get(list_id)
    const uri_path = `${config.BASE_URL}${config.UPLOADS_DIR}/${list.image_path}`;
    list.image_path = uri_path;
    if (!list) return res.status(404).send({ error: 'List not found' });
    res.status(200).json(list);
});

app.get('/list', Auth, (req, res) => {
    const stmt = db.prepare(`
        SELECT list.id, list.owner_id, list.name, list.updated_at, list.image_path
        FROM shared_with
        JOIN lists AS list ON list_id = list.id AND user_id = ?
        UNION
        SELECT id, owner_id, name, updated_at, image_path
        FROM lists
        WHERE owner_id = ?;
    `);
    const lists = stmt.all(req.user_id, req.user_id)
    lists.forEach(element => {
        const uri_path = `${config.BASE_URL}${config.UPLOADS_DIR}/${element.image_path}`;
        element.image_path = uri_path;
    });
    if (!lists) return res.status(200).json([]);
    res.status(200).json(lists);
});