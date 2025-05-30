const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const dotenv = require("dotenv");
const crypto = require("crypto");

dotenv.config();
const app = express();
const PORT = 3000;
const PASSWORD = process.env.MASTER_PASSWORD;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// directories for temporary and final files
const TEMP_DIR = "temp/";
const UPLOADS_DIR = "uploads/";
const THUMBS_DIR = "thumbnails/";

// create directories if they don't exist
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR);

// store active processing sessions
const processingStatus = new Map();

function authMiddleware(req, res, next) {
  const providedPassword = req.headers.authorization;
  console.log("🔐 auth check - password provided:", !!providedPassword);

  if (!providedPassword) {
    console.log("❌ auth failed: no password provided");
    return res.status(401).json({
      success: false,
      error: "MISSING_PASSWORD",
      message: "password required",
    });
  }

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

// generate random filename
function generateRandomName() {
  return crypto.randomBytes(16).toString("hex");
}

const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => {
    const randomName = generateRandomName();
    const ext = path.extname(file.originalname);
    const filename = `${randomName}${ext}`;
    console.log("📁 storing temp file:", filename);
    cb(null, filename);
  },
});
const upload = multer({ storage });

app.use(express.static("public"));

// generate thumbnail for video
function generateThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log("🖼️ generating thumbnail for:", videoPath);

    const command = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2" "${outputPath}" -y`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ thumbnail generation failed:", error.message);
        resolve(false); // don't fail the whole process if thumbnail fails
      } else {
        console.log("✅ thumbnail generated successfully");
        resolve(true);
      }
    });
  });
}

// function to process video with progress tracking
function processVideoWithProgress(
  sessionId,
  inputPath,
  outputPath,
  originalFilename,
  customName
) {
  return new Promise((resolve, reject) => {
    console.log("🎬 starting video processing with progress tracking...");
    console.log("📂 input path:", inputPath);
    console.log("📂 output path:", outputPath);

    // initialize processing status
    processingStatus.set(sessionId, {
      phase: "validating",
      progress: 0,
      message: "validating video file...",
    });

    // check if input file exists
    if (!fs.existsSync(inputPath)) {
      console.log("❌ input file doesn't exist:", inputPath);
      processingStatus.delete(sessionId);
      return reject(new Error("INPUT_NOT_FOUND"));
    }

    const inputStats = fs.statSync(inputPath);
    console.log("📊 input file size:", inputStats.size, "bytes");

    // first check file integrity with ffprobe
    const probeCommand = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`;
    console.log("🔍 running ffprobe command:", probeCommand);

    processingStatus.set(sessionId, {
      phase: "validating",
      progress: 10,
      message: "checking video integrity...",
    });

    exec(probeCommand, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ ffprobe error:", err.message);
        processingStatus.delete(sessionId);
        return reject(new Error("CORRUPTED"));
      }

      const duration = parseFloat(stdout.trim());
      console.log("✅ video duration:", duration, "seconds");

      processingStatus.set(sessionId, {
        phase: "processing",
        progress: 20,
        message: "converting video format...",
        duration: duration,
      });

      // process video with ffmpeg and track progress
      const ffmpegArgs = [
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-c:a",
        "aac",
        "-strict",
        "experimental",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-y",
        outputPath,
      ];

      console.log("🔄 starting ffmpeg with args:", ffmpegArgs.join(" "));

      const ffmpeg = spawn("ffmpeg", ffmpegArgs);
      let ffmpegOutput = "";

      ffmpeg.stdout.on("data", (data) => {
        ffmpegOutput += data.toString();

        // parse ffmpeg progress output
        const lines = ffmpegOutput.split("\n");
        let currentTime = 0;

        for (const line of lines) {
          if (line.startsWith("out_time_us=")) {
            const timeUs = parseInt(line.split("=")[1]);
            currentTime = timeUs / 1000000; // convert to seconds
          }
        }

        if (duration > 0 && currentTime > 0) {
          const progress = Math.min(
            Math.round((currentTime / duration) * 100),
            95
          );
          processingStatus.set(sessionId, {
            phase: "processing",
            progress: Math.max(20, progress),
            message: `converting video... ${Math.round(
              currentTime
            )}s / ${Math.round(duration)}s`,
            duration: duration,
          });
        }
      });

      ffmpeg.stderr.on("data", (data) => {
        // ffmpeg sends progress info to stderr too
        console.log("ffmpeg stderr:", data.toString());
      });

      ffmpeg.on("close", async (code) => {
        if (code !== 0) {
          console.error("❌ ffmpeg conversion failed with code:", code);
          processingStatus.delete(sessionId);
          return reject(new Error("CONVERSION_FAILED"));
        }

        console.log("✅ ffmpeg conversion completed");

        // verify output file
        if (!fs.existsSync(outputPath)) {
          console.log("❌ output file was not created:", outputPath);
          processingStatus.delete(sessionId);
          return reject(new Error("OUTPUT_INVALID"));
        }

        const outputStats = fs.statSync(outputPath);
        console.log("📊 output file size:", outputStats.size, "bytes");

        if (outputStats.size === 0) {
          console.log("❌ output file is empty");
          processingStatus.delete(sessionId);
          return reject(new Error("OUTPUT_INVALID"));
        }

        // generate thumbnail
        processingStatus.set(sessionId, {
          phase: "thumbnail",
          progress: 90,
          message: "generating thumbnail...",
        });

        const finalName = customName
          ? customName.replace(/[^a-zA-Z0-9-_\s]/g, "_").trim() + ".mp4"
          : path.parse(originalFilename).name + ".mp4";

        const finalPath = path.join(UPLOADS_DIR, finalName);
        const thumbnailPath = path.join(
          THUMBS_DIR,
          finalName.replace(".mp4", ".jpg")
        );

        console.log("📂 moving to final path:", finalPath);

        try {
          // move processed video to uploads directory
          fs.renameSync(outputPath, finalPath);

          // generate thumbnail
          await generateThumbnail(finalPath, thumbnailPath);

          processingStatus.set(sessionId, {
            phase: "completed",
            progress: 100,
            message: "processing completed!",
            filename: finalName,
          });

          console.log("🎉 video processing completed successfully!");
          resolve({ filename: finalName, finalPath });
        } catch (moveError) {
          console.error("❌ error moving file:", moveError.message);
          processingStatus.delete(sessionId);
          reject(new Error("FILE_MOVE_FAILED"));
        }
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

    const sessionId = generateRandomName();
    const tempPath = req.file.path;
    const randomName = generateRandomName();
    const processingPath = path.join(TEMP_DIR, `processing-${randomName}.mp4`);

    console.log("🆔 session ID:", sessionId);
    console.log("📂 temp file path:", tempPath);
    console.log("📂 processing path:", processingPath);

    // return session ID immediately for progress tracking
    res.json({
      success: true,
      sessionId: sessionId,
      message: "upload received, processing started",
    });

    try {
      // process video asynchronously
      await processVideoWithProgress(
        sessionId,
        tempPath,
        processingPath,
        req.file.originalname,
        req.body.customName
      );

      console.log("🧹 cleaning up temp file...");
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
        console.log("✅ temp file deleted");
      }
    } catch (error) {
      console.log("❌ processing failed with error:", error.message);

      // cleanup on error
      [tempPath, processingPath].forEach((filePath) => {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log("🧹 cleaned up:", filePath);
        }
      });

      processingStatus.set(sessionId, {
        phase: "error",
        progress: 0,
        message: `error: ${error.message}`,
        error: true,
      });
    }
  }
);

// endpoint to check processing progress
app.get("/progress/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  const status = processingStatus.get(sessionId);

  if (!status) {
    return res.status(404).json({
      success: false,
      error: "session not found",
    });
  }

  res.json({
    success: true,
    ...status,
  });

  // clean up completed or errored sessions after sending response
  if (status.phase === "completed" || status.phase === "error") {
    setTimeout(() => {
      processingStatus.delete(sessionId);
    }, 5000);
  }
});

app.post("/rename", authMiddleware, (req, res) => {
  console.log("\n📝 rename request:", req.body);
  const { original, newName } = req.body;
  const oldPath = path.join(UPLOADS_DIR, original);
  const safeNewName = newName.replace(/[^a-zA-Z0-9-_\s]/g, "_").trim();
  const finalNewName = safeNewName + ".mp4";
  const newPath = path.join(UPLOADS_DIR, finalNewName);

  // also rename thumbnail
  const oldThumbPath = path.join(THUMBS_DIR, original.replace(".mp4", ".jpg"));
  const newThumbPath = path.join(
    THUMBS_DIR,
    finalNewName.replace(".mp4", ".jpg")
  );

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

    // rename thumbnail if it exists
    if (fs.existsSync(oldThumbPath)) {
      fs.renameSync(oldThumbPath, newThumbPath);
      console.log("✅ thumbnail also renamed");
    }

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

    // add thumbnail info
    const videosWithThumbs = files.map((file) => {
      const thumbPath = path.join(THUMBS_DIR, file.replace(".mp4", ".jpg"));
      return {
        filename: file,
        thumbnail: fs.existsSync(thumbPath)
          ? `/thumbnail/${file.replace(".mp4", ".jpg")}`
          : null,
      };
    });

    console.log("📁 found", files.length, "video files:", files);
    res.json(videosWithThumbs);
  } catch (error) {
    console.log("❌ error listing videos:", error.message);
    res.status(500).json({ error: "error listing videos" });
  }
});

// serve thumbnails
app.get("/thumbnail/:filename", (req, res) => {
  const thumbPath = path.join(__dirname, THUMBS_DIR, req.params.filename);

  if (!fs.existsSync(thumbPath)) {
    return res.status(404).send("thumbnail not found");
  }

  res.setHeader("Content-Type", "image/jpeg");
  fs.createReadStream(thumbPath).pipe(res);
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
  console.log("📁 thumbnails directory:", THUMBS_DIR);
  console.log("🔐 password protection:", !!PASSWORD);
});
