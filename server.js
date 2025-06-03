const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 7777;

const { TEMP_DIR, UPLOADS_DIR, THUMBNAILS_DIR } = require("./config");

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

const videoRoutes = require("./src/routes/videoRoutes");
const authRoutes = require("./src/routes/authRoutes");

app.use("/", videoRoutes);
app.use("/", authRoutes);

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("📁 Temp directory:", path.resolve(TEMP_DIR));
  console.log("📁 Uploads directory:", path.resolve(UPLOADS_DIR));
  console.log("📁 Thumbnails directory:", path.resolve(THUMBNAILS_DIR));
  console.log(
    "🔐 Password protection:",
    !!process.env.MASTER_PASSWORD || !!process.env.SPECIAL_PASSWORD
  );
});
