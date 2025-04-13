const fs = require('fs')
const path = require('path')
require('dotenv').config()

db_name = process.env.DB_NAME || './database.db';
express_port = process.env.PORT || 8080
express_domain = process.env.SERVER_DOMAIN || 'localhost'
uploads_dir = process.env.UPLOADS_DIR || 'uploads'
project_root = process.cwd()

if (!fs.existsSync(uploads_dir))
    fs.mkdirSync(uploads_dir, { recursive: true });

module.exports = {
    PORT: express_port,
    DB_NAME: db_name,
    DB_PATH: path.join(project_root, db_name),
    JWT_SECRET: process.env.JWT_SECRET || 'secret',
    JWT_SALTROUNDS: parseInt(process.env.JWT_SALTROUNDS) || 10,
    SERVER_DOMAIN: express_domain,
    UPLOADS_DIR: uploads_dir,
    UPLOADS_DIR_PATH: path.join(project_root, uploads_dir),
    BASE_URL: `http://${express_domain}:${express_port}/`,
    IMAGE_MAX_SIZE: parseInt(process.env.IMAGE_MAX_SIZE) || 10485760,
    PROJECT_ROOT: project_root
}