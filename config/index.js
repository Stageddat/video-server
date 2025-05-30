// config/index.js
const path = require("path");

module.exports = {
  PORT: process.env.PORT || 80,
  MASTER_PASSWORD: process.env.MASTER_PASSWORD,
  SPECIAL_PASSWORD: process.env.SPECIAL_PASSWORD,
  TEMP_DIR: "temp/",
  UPLOADS_DIR: "uploads/",
  THUMBNAILS_DIR: "thumbnails/",
};
