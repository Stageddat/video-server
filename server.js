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

// directories for temporary and final files
const TEMP_DIR = "temp/";
const UPLOADS_DIR = "uploads/";

// create directories if they don't exist
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

function authMiddleware(req, res, next) {
  const providedPassword = req.headers.authorization;
  console.log("🔐 auth check - password provided:", !!providedPassword);

  // verify if password was provided
  if (!providedPassword) {
    console.log("❌ auth failed: no password provided");
    return res.status(401).json({
      success: false,
      error: "MISSING_PASSWORD",
      message: "password required",
    });
  }

  // verify if the password is correct
  if (providedPassword !== PASSWORD) {
    console.log("❌ auth failed: wrong password");
    return res.status(401).json({
      success: false,
      error: "WRONG_PASSWORD",
      message: "wrong password",
    });
  }

  console.log("✅ auth successful");
  next();
}

const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const filename = `temp_${timestamp}${ext}`;
    console.log("📁 storing temp file:", filename);
    cb(null, filename);
  },
});
const upload = multer({ storage });

app.use(express.static("public"));

// function to verify and repair video
function processVideo(inputPath, outputPath) {
  console.log("🎬 starting video processing...");
  console.log("📂 input path:", inputPath);
  console.log("📂 output path:", outputPath);

  return new Promise((resolve, reject) => {
    // check if input file exists
    if (!fs.existsSync(inputPath)) {
      console.log("❌ input file doesn't exist:", inputPath);
      return reject(new Error("INPUT_NOT_FOUND"));
    }

    const inputStats = fs.statSync(inputPath);
    console.log("📊 input file size:", inputStats.size, "bytes");

    // first check file integrity
    const probeCommand = `ffprobe -v error -show_entries format=duration "${inputPath}"`;
    console.log("🔍 running ffprobe command:", probeCommand);

    exec(probeCommand, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ ffprobe error:", err.message);
        console.error("❌ ffprobe stderr:", stderr);
        return reject(new Error("CORRUPTED"));
      }

      console.log("✅ ffprobe successful, file appears valid");
      console.log("📋 ffprobe output:", stdout);

      // if file is valid, try to convert/repair it
      const ffmpegCommand = `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -c:a aac -strict experimental -movflags +faststart "${outputPath}" -y`;
      console.log("🔄 running ffmpeg command:", ffmpegCommand);

      const startTime = Date.now();

      exec(ffmpegCommand, (convertErr, convertStdout, convertStderr) => {
        const processingTime = Date.now() - startTime;
        console.log("⏱️ ffmpeg processing took:", processingTime, "ms");

        if (convertErr) {
          console.error("❌ ffmpeg conversion error:", convertErr.message);
          console.error("❌ ffmpeg stderr:", convertStderr);
          return reject(new Error("CONVERSION_FAILED"));
        }

        console.log("✅ ffmpeg conversion completed");
        if (convertStdout) console.log("📋 ffmpeg stdout:", convertStdout);

        // verify output file was created correctly
        if (!fs.existsSync(outputPath)) {
          console.log("❌ output file was not created:", outputPath);
          return reject(new Error("OUTPUT_INVALID"));
        }

        const outputStats = fs.statSync(outputPath);
        console.log("📊 output file size:", outputStats.size, "bytes");

        if (outputStats.size === 0) {
          console.log("❌ output file is empty");
          return reject(new Error("OUTPUT_INVALID"));
        }

        console.log("🎉 video processing completed successfully!");
        resolve();
      });
    });
  });
}

app.post(
  "/upload",
  authMiddleware,
  upload.single("video"),
  async (req, res) => {
    console.log("\n🚀 upload request received");
    console.log("📁 original filename:", req.file?.originalname);
    console.log("📊 file size:", req.file?.size, "bytes");
    console.log("🏷️ mime type:", req.file?.mimetype);

    const tempPath = req.file.path;
    const timestamp = Date.now();
    const finalName = `${timestamp}.mp4`;
    const finalPath = path.join(UPLOADS_DIR, finalName);

    console.log("📂 temp file path:", tempPath);
    console.log("📂 final file path:", finalPath);

    try {
      console.log("🎬 starting video processing...");

      // process video (verify and convert)
      await processVideo(tempPath, finalPath);

      console.log("🧹 cleaning up temp file...");
      // delete temp file
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
        console.log("✅ temp file deleted");
      } else {
        console.log("⚠️ temp file not found for deletion");
      }

      console.log("🎉 upload completed successfully!");
      res.json({
        success: true,
        filename: finalName,
        message: "video processed successfully",
      });
    } catch (error) {
      console.log("❌ upload failed with error:", error.message);

      // delete temp files on error
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
        console.log("🧹 temp file cleaned up after error");
      }
      if (fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
        console.log("🧹 output file cleaned up after error");
      }

      let errorMessage = "unknown error";
      if (error.message === "CORRUPTED") {
        errorMessage = "file is corrupted or not a valid video";
      } else if (error.message === "CONVERSION_FAILED") {
        errorMessage = "couldn't process the video";
      } else if (error.message === "OUTPUT_INVALID") {
        errorMessage = "processed video is not valid";
      } else if (error.message === "INPUT_NOT_FOUND") {
        errorMessage = "input file not found";
      }

      console.log("📤 sending error response:", errorMessage);
      res.status(400).json({
        success: false,
        error: errorMessage,
      });
    }
  }
);

app.post("/rename", authMiddleware, (req, res) => {
  console.log("\n📝 rename request:", req.body);
  const { original, newName } = req.body;
  const oldPath = path.join(UPLOADS_DIR, original);
  const safeNewName = newName.replace(/[^a-zA-Z0-9-_\s]/g, "_").trim();
  const finalNewName = safeNewName + ".mp4";
  const newPath = path.join(UPLOADS_DIR, finalNewName);

  console.log("📂 old path:", oldPath);
  console.log("📂 new path:", newPath);

  if (!fs.existsSync(oldPath)) {
    console.log("❌ original file not found");
    return res.status(404).json({
      success: false,
      error: "original file not found",
    });
  }

  try {
    fs.renameSync(oldPath, newPath);
    console.log("✅ file renamed successfully");
    res.json({
      success: true,
      newName: finalNewName,
      message: `name changed to: ${finalNewName}`,
    });
  } catch (error) {
    console.log("❌ rename error:", error.message);
    res.status(500).json({
      success: false,
      error: "error renaming file",
    });
  }
});

app.get("/videos", (req, res) => {
  console.log("\n📋 listing videos request");
  try {
    const files = fs.readdirSync(UPLOADS_DIR).filter((f) => f.endsWith(".mp4"));
    console.log("📁 found", files.length, "video files:", files);
    res.json(files);
  } catch (error) {
    console.log("❌ error listing videos:", error.message);
    res.status(500).json({ error: "error listing videos" });
  }
});

app.get("/video/:filename", (req, res) => {
  console.log("\n🎥 video stream request for:", req.params.filename);
  const filePath = path.join(__dirname, UPLOADS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    console.log("❌ video file not found:", filePath);
    return res.status(404).send("video not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  console.log("📊 file size:", fileSize, "bytes");
  console.log("📡 range header:", range);

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    console.log("📦 streaming chunk:", start, "-", end, "/", fileSize);

    const file = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    });

    file.pipe(res);
  } else {
    console.log("📦 streaming entire file");
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    });

    fs.createReadStream(filePath).pipe(res);
  }
});

// endpoint to clean temp files (optional)
app.post("/cleanup", authMiddleware, (req, res) => {
  console.log("\n🧹 cleanup request");
  try {
    const tempFiles = fs.readdirSync(TEMP_DIR);
    console.log("📁 found", tempFiles.length, "temp files:", tempFiles);

    tempFiles.forEach((file) => {
      fs.unlinkSync(path.join(TEMP_DIR, file));
      console.log("🗑️ deleted:", file);
    });

    console.log("✅ cleanup completed");
    res.json({ success: true, message: "temp files deleted" });
  } catch (error) {
    console.log("❌ cleanup error:", error.message);
    res
      .status(500)
      .json({ success: false, error: "error cleaning temp files" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 server running on http://localhost:${PORT}`);
  console.log("📁 temp directory:", TEMP_DIR);
  console.log("📁 uploads directory:", UPLOADS_DIR);
  console.log("🔐 password protection:", !!PASSWORD);
});
