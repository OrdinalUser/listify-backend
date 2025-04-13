// Handles image upload of lists

const path = require('path')
const config = require('./config')
const multer = require('multer')

const allowedExts = ['.png', '.jpg', '.jpeg', '.webp']

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, `${config.UPLOADS_DIR}/`)
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, uniqueName + ext);
    }
})

const imageFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExts.includes(ext))
        return cb(new multer.MulterError("UNSUPPORTED_FORMAT"), false);
    cb(null, true)
}

const upload = multer({
    storage: storage,
    limits: { fileSize: config.IMAGE_MAX_SIZE },
    fileFilter: imageFilter
});

// Express middleware to deal with errors created by this module
function handleUploadError(err, req, res, next)
{
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(413).send({ error: `File too big. Max file size ${config.IMAGE_MAX_SIZE} bytes.`} );
        else if (err.code == 'UNSUPPORTED_FORMAT')
            return res.status(415).send({ error: "Unsupported image format. Use ('.png' '.jpg' '.jpeg' '.webp')" });
        else if (err)
            return res.status(400).send({ error: "Something went wrong and it's your fault :)"} );
    }
    next();
}

module.exports = {
    upload, handleUploadError
};