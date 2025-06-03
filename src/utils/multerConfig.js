const multer = require("multer");
const path = require("path");
const { TEMP_DIR } = require("../../config");

const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const uniqueSuffix = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname) || ".mp4";
    const rawTempFilename = `raw_${timestamp}_${uniqueSuffix}${ext}`;
    cb(null, rawTempFilename);
  },
});

const upload = multer({ storage });

module.exports = upload;
