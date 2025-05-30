const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const dotenv = require("dotenv");

dotenv.config();
const app = express();
const PORT = 3000;
const PASSWORD = process.env.MASTER_PASSWORD;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Directorio para archivos temporales y finales
const TEMP_DIR = "temp/";
const UPLOADS_DIR = "uploads/";

// Crear directorios si no existen
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

function authMiddleware(req, res, next) {
  if (req.headers.authorization === PASSWORD) {
    next();
  } else {
    res.status(401).send("unauthorized");
  }
}

const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `temp_${timestamp}${ext}`);
  },
});
const upload = multer({ storage });

app.use(express.static("public"));

// function to verify and repair video
function processVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // first check file integrity
    exec(
      `ffprobe -v error -show_entries format=duration "${inputPath}"`,
      (err, stdout) => {
        if (err) {
          console.error("corrupted or invalid file:", err.message);
          return reject(new Error("CORRUPTED"));
        }

        // if file is valid, try to convert/repair it
        const ffmpegCommand = `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -c:a aac -strict experimental -movflags +faststart "${outputPath}" -y`;

        exec(ffmpegCommand, (convertErr, convertStdout, convertStderr) => {
          if (convertErr) {
            console.error("conversion error:", convertStderr);
            return reject(new Error("CONVERSION_FAILED"));
          }

          // verify output file was created correctly
          if (
            !fs.existsSync(outputPath) ||
            fs.statSync(outputPath).size === 0
          ) {
            return reject(new Error("OUTPUT_INVALID"));
          }

          resolve();
        });
      }
    );
  });
}

app.post(
  "/upload",
  authMiddleware,
  upload.single("video"),
  async (req, res) => {
    const tempPath = req.file.path;
    const timestamp = Date.now();
    const finalName = `${timestamp}.mp4`;
    const finalPath = path.join(UPLOADS_DIR, finalName);

    try {
      // process video (verify and convert)
      await processVideo(tempPath, finalPath);

      // delete temp file
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      res.json({
        success: true,
        filename: finalName,
        message: "video processed successfully",
      });
    } catch (error) {
      // delete temp files on error
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      if (fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
      }

      let errorMessage = "unknown error";
      if (error.message === "CORRUPTED") {
        errorMessage = "file is corrupted or not a valid video";
      } else if (error.message === "CONVERSION_FAILED") {
        errorMessage = "couldn't process the video";
      } else if (error.message === "OUTPUT_INVALID") {
        errorMessage = "processed video is not valid";
      }

      res.status(400).json({
        success: false,
        error: errorMessage,
      });
    }
  }
);

app.post("/rename", authMiddleware, (req, res) => {
  const { original, newName } = req.body;
  const oldPath = path.join(UPLOADS_DIR, original);
  const safeNewName = newName.replace(/[^a-zA-Z0-9-_\s]/g, "_").trim();
  const finalNewName = safeNewName + ".mp4";
  const newPath = path.join(UPLOADS_DIR, finalNewName);

  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({
      success: false,
      error: "original file not found",
    });
  }

  try {
    fs.renameSync(oldPath, newPath);
    res.json({
      success: true,
      newName: finalNewName,
      message: `name changed to: ${finalNewName}`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "error renaming file",
    });
  }
});

app.get("/videos", (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR).filter((f) => f.endsWith(".mp4"));
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: "error listing videos" });
  }
});

app.get("/video/:filename", (req, res) => {
  const filePath = path.join(__dirname, UPLOADS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("video not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    });

    file.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    });

    fs.createReadStream(filePath).pipe(res);
  }
});

// endpoint to clean temp files (optional)
app.post("/cleanup", authMiddleware, (req, res) => {
  try {
    const tempFiles = fs.readdirSync(TEMP_DIR);
    tempFiles.forEach((file) => {
      fs.unlinkSync(path.join(TEMP_DIR, file));
    });
    res.json({ success: true, message: "temp files deleted" });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: "error cleaning temp files" });
  }
});

app.listen(PORT, () => {
  console.log(`server running on http://localhost:${PORT}`);
});
