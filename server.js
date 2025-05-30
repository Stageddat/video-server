const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const dotenv = require("dotenv");
const EventEmitter = require("events");

dotenv.config();
const app = express();
const PORT = 3000;
const PASSWORD = process.env.MASTER_PASSWORD;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TEMP_DIR = "temp/";
const UPLOADS_DIR = "uploads/";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const taskProgressEmitters = {};

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

const storage = multer.diskStorage({
  destination: TEMP_DIR,
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const uniqueSuffix = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname) || ".mp4"; // Ensure extension
    // This filename is for the *raw* uploaded file in TEMP_DIR
    const rawTempFilename = `raw_${timestamp}_${uniqueSuffix}${ext}`;
    console.log("📁 Storing raw uploaded file in temp as:", rawTempFilename);
    cb(null, rawTempFilename);
  },
});
const upload = multer({ storage });

app.use(express.static("public"));

// Utility to safely clean up files
function safeUnlink(filePath, taskId, fileDescription) {
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`[${taskId}] 🧹 ${fileDescription} deleted: ${filePath}`);
    } catch (err) {
      console.error(
        `[${taskId}] ⚠️ Error deleting ${fileDescription} ${filePath}:`,
        err.message
      );
    }
  }
}

async function processVideo(
  rawTempFilePath, // Full path to the raw uploaded file in TEMP_DIR
  processingTempFilePath, // Full path for ffmpeg's output, also in TEMP_DIR
  finalNameForUploads, // Just the filename (e.g., "12345.mp4") for UPLOADS_DIR
  taskId,
  originalFilename // Original name of the uploaded file for logging/metadata
) {
  console.log(
    `[${taskId}] 🎬 Starting video processing for original: ${originalFilename}`
  );
  const emitter = taskProgressEmitters[taskId];
  if (!emitter) {
    console.error(`[${taskId}] ❌ No emitter found. Aborting processing.`);
    safeUnlink(rawTempFilePath, taskId, "Raw temp input file (no emitter)");
    return;
  }

  try {
    if (!fs.existsSync(rawTempFilePath)) {
      console.log(
        `[${taskId}] ❌ Raw input file doesn't exist:`,
        rawTempFilePath
      );
      emitter.emit("error", {
        message: "INPUT_NOT_FOUND",
        error: "Input file for processing not found.",
      });
      return;
    }
    emitter.emit("progress", {
      stage: "probing",
      message: "Analyzing video...",
    });

    const probeCommand = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawTempFilePath}"`;
    console.log(`[${taskId}] 🔍 Running ffprobe:`, probeCommand);

    let totalDuration = 0;
    try {
      const stdout = await new Promise((resolve, reject) => {
        exec(probeCommand, (err, stdout, stderr) => {
          if (err) {
            console.error(`[${taskId}] ❌ ffprobe error:`, err.message, stderr);
            return reject(new Error("PROBE_FAILED"));
          }
          resolve(stdout.trim());
        });
      });
      totalDuration = parseFloat(stdout);
      if (isNaN(totalDuration) || totalDuration <= 0)
        throw new Error("INVALID_DURATION");
      console.log(
        `[${taskId}] ✅ ffprobe successful, duration:`,
        totalDuration,
        "seconds"
      );
      emitter.emit("progress", {
        stage: "probed_success",
        message: `Video duration: ${totalDuration.toFixed(
          2
        )}s. Starting conversion...`,
        duration: totalDuration,
      });
    } catch (probeError) {
      console.error(
        `[${taskId}] ❌ Error getting video duration:`,
        probeError.message
      );
      emitter.emit("error", {
        message:
          probeError.message === "INVALID_DURATION"
            ? "INVALID_DURATION"
            : "CORRUPTED",
        error: "Could not determine video duration or file is corrupted.",
      });
      safeUnlink(rawTempFilePath, taskId, "Raw temp input file (probe error)");
      return;
    }

    const ffmpegArgs = [
      "-i",
      rawTempFilePath,
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
      processingTempFilePath, // Output to the "processing" temp file
      "-y",
    ];
    console.log(
      `[${taskId}] 🔄 Running ffmpeg: ffmpeg ${ffmpegArgs.join(" ")}`
    );
    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);
    const startTime = Date.now();

    ffmpegProcess.stderr.on("data", (data) => {
      const stdErrStr = data.toString();
      const timeMatch = stdErrStr.match(
        /time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/
      );
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10),
          minutes = parseInt(timeMatch[2], 10),
          seconds = parseInt(timeMatch[3], 10),
          ms = parseInt(timeMatch[4], 10) * 10;
        const currentTime = hours * 3600 + minutes * 60 + seconds + ms / 1000;
        const percentage = Math.min(
          100,
          Math.max(0, (currentTime / totalDuration) * 100)
        );
        emitter.emit("progress", {
          stage: "processing",
          percent: percentage.toFixed(2),
          message: `Processing... ${percentage.toFixed(2)}%`,
        });
      }
    });

    ffmpegProcess.on("close", (code) => {
      const processingTime = Date.now() - startTime;
      console.log(
        `[${taskId}] ⏱️ ffmpeg processing took:`,
        processingTime,
        "ms. Exit code:",
        code
      );

      if (code === 0) {
        if (
          !fs.existsSync(processingTempFilePath) ||
          fs.statSync(processingTempFilePath).size === 0
        ) {
          console.log(
            `[${taskId}] ❌ Processed temp file not created or empty:`,
            processingTempFilePath
          );
          emitter.emit("error", {
            message: "OUTPUT_INVALID",
            error: "Processed video is not valid.",
          });
          safeUnlink(
            rawTempFilePath,
            taskId,
            "Raw temp input file (output invalid)"
          );
          safeUnlink(
            processingTempFilePath,
            taskId,
            "Invalid processed temp file"
          );
          return;
        }

        const finalUploadsPath = path.join(UPLOADS_DIR, finalNameForUploads);
        try {
          fs.renameSync(processingTempFilePath, finalUploadsPath); // Move to UPLOADS_DIR
          console.log(
            `[${taskId}] ✅ Processed file moved to: ${finalUploadsPath}`
          );
          emitter.emit("done", {
            filename: finalNameForUploads,
            message: "Video processed successfully.",
          });
        } catch (renameError) {
          console.error(
            `[${taskId}] ❌ Error moving processed file to uploads:`,
            renameError
          );
          emitter.emit("error", {
            message: "MOVE_FAILED",
            error: "Could not move processed video to final destination.",
          });
          safeUnlink(
            processingTempFilePath,
            taskId,
            "Processed temp file (move failed)"
          ); // processingTempFilePath still exists
        }
      } else {
        // ffmpeg failed
        console.error(
          `[${taskId}] ❌ ffmpeg conversion failed with code ${code}`
        );
        emitter.emit("error", {
          message: "CONVERSION_FAILED",
          error: "Video conversion failed.",
        });
        safeUnlink(
          processingTempFilePath,
          taskId,
          "Failed processed temp file"
        );
      }
      // Always cleanup the raw temp file after attempting processing (success or ffmpeg failure)
      safeUnlink(rawTempFilePath, taskId, "Raw temp input file (post-process)");
    });

    ffmpegProcess.on("error", (err) => {
      console.error(`[${taskId}] ❌ Failed to start ffmpeg process:`, err);
      emitter.emit("error", {
        message: "FFMPEG_SPAWN_ERROR",
        error: "Could not start video processing.",
      });
      safeUnlink(
        rawTempFilePath,
        taskId,
        "Raw temp input file (ffmpeg spawn error)"
      );
      safeUnlink(
        processingTempFilePath,
        taskId,
        "Processing temp file (ffmpeg spawn error)"
      );
    });
  } catch (error) {
    console.error(
      `[${taskId}] ❌ General error in processVideo:`,
      error.message,
      error.stack
    );
    emitter.emit("error", {
      message: "PROCESS_VIDEO_ERROR",
      error: "An unexpected error occurred during video processing setup.",
    });
    safeUnlink(rawTempFilePath, taskId, "Raw temp input file (general error)");
    safeUnlink(
      processingTempFilePath,
      taskId,
      "Processing temp file (general error)"
    );
  }
}

app.post(
  "/upload",
  authMiddleware,
  upload.single("video"),
  async (req, res) => {
    console.log("\n🚀 Upload request received");
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "NO_FILE",
        message: "No video file provided.",
      });
    }

    const rawTempFilePath = req.file.path; // Full path to raw file in TEMP_DIR (e.g., temp/raw_timestamp_suffix.mp4)
    const originalFilename = req.file.originalname;

    console.log(
      `📁 Original filename: ${originalFilename}, Raw temp stored at: ${rawTempFilePath}`
    );
    console.log(
      `📊 File size: ${req.file.size} bytes, Mime type: ${req.file.mimetype}`
    );

    const taskId =
      Date.now().toString() + Math.random().toString(36).substring(2, 7);

    // Define the name for the "processing" output file in TEMP_DIR
    const processingFileExt = path.extname(originalFilename) || ".mp4";
    const processingFileName = `processing_${taskId}${processingFileExt}`;
    const processingTempFilePath = path.join(TEMP_DIR, processingFileName);

    // Define the final name for the file once it's in UPLOADS_DIR
    const finalTimestamp = Date.now(); // Use a new timestamp for the final processed file
    const finalNameForUploads = `${finalTimestamp}.mp4`;

    console.log(`[${taskId}] 📂 Raw temp file: ${rawTempFilePath}`);
    console.log(
      `[${taskId}] 🌀 Processing temp output file: ${processingTempFilePath}`
    );
    console.log(
      `[${taskId}] 🏁 Final uploads file name: ${finalNameForUploads}`
    );

    taskProgressEmitters[taskId] = new EventEmitter();

    processVideo(
      rawTempFilePath,
      processingTempFilePath,
      finalNameForUploads,
      taskId,
      originalFilename
    ).catch((err) => {
      console.error(
        `[${taskId}] ❌ Uncaught error in processVideo async wrapper:`,
        err
      );
      if (taskProgressEmitters[taskId]) {
        taskProgressEmitters[taskId].emit("error", {
          message: "ASYNC_PROCESS_ERROR",
          error: "Critical error in video processing.",
        });
      }
      // Ensure cleanup if processVideo itself throws an unhandled error before ffmpeg starts
      safeUnlink(
        rawTempFilePath,
        taskId,
        "Raw temp file (async wrapper error)"
      );
      safeUnlink(
        processingTempFilePath,
        taskId,
        "Processing temp file (async wrapper error)"
      );
    });

    res.json({
      success: true,
      taskId: taskId,
      message: "Upload received, processing started.",
    });
  }
);

app.get("/processing-status/:taskId", (req, res) => {
  const { taskId } = req.params;
  console.log(`[${taskId}] 🛰️ Client connected for status updates.`);

  const emitter = taskProgressEmitters[taskId];
  if (!emitter) {
    console.log(`[${taskId}] 🛰️ No emitter for task ID. Sending 404.`);
    return res
      .status(404)
      .json({ error: "Task not found or already completed." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  const onProgress = (data) => {
    // console.log(`[${taskId}] 🛰️ Sending progress:`, data); // Verbose
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onDone = (data) => {
    console.log(`[${taskId}] 🛰️ Sending done:`, data);
    res.write(`data: ${JSON.stringify({ ...data, stage: "done" })}\n\n`);
    res.end();
    cleanupTaskEmitter(taskId, {
      progress: onProgress,
      done: onDone,
      error: onError,
    });
  };

  const onError = (data) => {
    console.log(`[${taskId}] 🛰️ Sending error:`, data);
    res.write(`data: ${JSON.stringify({ ...data, stage: "error" })}\n\n`);
    res.end();
    cleanupTaskEmitter(taskId, {
      progress: onProgress,
      done: onDone,
      error: onError,
    });
  };

  function cleanupTaskEmitter(id, listeners) {
    if (taskProgressEmitters[id]) {
      taskProgressEmitters[id].removeListener("progress", listeners.progress);
      taskProgressEmitters[id].removeListener("done", listeners.done);
      taskProgressEmitters[id].removeListener("error", listeners.error);
      if (
        taskProgressEmitters[id].listenerCount("progress") === 0 &&
        taskProgressEmitters[id].listenerCount("done") === 0 &&
        taskProgressEmitters[id].listenerCount("error") === 0
      ) {
        console.log(`[${id}] All listeners removed, deleting emitter.`);
        delete taskProgressEmitters[id];
      }
    }
  }

  emitter.on("progress", onProgress);
  emitter.on("done", onDone);
  emitter.on("error", onError);

  req.on("close", () => {
    console.log(`[${taskId}] 🛰️ Client disconnected.`);
    cleanupTaskEmitter(taskId, {
      progress: onProgress,
      done: onDone,
      error: onError,
    });
  });
});

// --- Rutas existentes (rename, videos, video/:filename, cleanup) ---
// Estas rutas no necesitan cambios funcionales para esta modificación.
// El endpoint /rename seguirá funcionando con el `filename` que se obtiene del evento 'done' del SSE.

app.post("/rename", authMiddleware, (req, res) => {
  console.log("\n📝 rename request:", req.body);
  const { original, newName } = req.body;
  const oldPath = path.join(UPLOADS_DIR, original);
  const safeNewName = newName.replace(/[^a-zA-Z0-9-_\s.]/g, "_").trim(); // Allow dots in safe name
  let finalNewName = safeNewName;
  if (!finalNewName.toLowerCase().endsWith(".mp4")) {
    // Ensure .mp4 extension
    finalNewName += ".mp4";
  }
  const newPath = path.join(UPLOADS_DIR, finalNewName);

  console.log("📂 old path:", oldPath);
  console.log("📂 new path:", newPath);

  if (oldPath === newPath) {
    console.log(
      "ℹ️ rename request: old and new names are the same after sanitization."
    );
    return res.json({
      success: true,
      newName: finalNewName,
      message: `File already has the name: ${finalNewName}`,
    });
  }

  if (!fs.existsSync(oldPath)) {
    console.log("❌ original file not found for rename:", oldPath);
    return res.status(404).json({
      success: false,
      error: "Original file not found. Was it processed correctly?",
    });
  }

  try {
    fs.renameSync(oldPath, newPath);
    console.log("✅ file renamed successfully to:", finalNewName);
    res.json({
      success: true,
      newName: finalNewName,
      message: `Name changed to: ${finalNewName}`,
    });
  } catch (error) {
    console.log("❌ rename error:", error.message);
    res.status(500).json({ success: false, error: "Error renaming file" });
  }
});

app.get("/videos", (req, res) => {
  console.log("\n📋 listing videos request");
  try {
    const files = fs
      .readdirSync(UPLOADS_DIR)
      .filter((f) => f.toLowerCase().endsWith(".mp4"));
    console.log("📁 found", files.length, "video files:", files);
    res.json(files);
  } catch (error) {
    console.log("❌ error listing videos:", error.message);
    res.status(500).json({ error: "Error listing videos" });
  }
});

app.get("/video/:filename", (req, res) => {
  console.log("\n🎥 video stream request for:", req.params.filename);
  const filePath = path.join(UPLOADS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    console.log("❌ video file not found:", filePath);
    return res.status(404).send("Video not found");
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

    if (start >= fileSize || end >= fileSize || start > end) {
      console.log("❌ Invalid range request");
      res.status(416).send("Requested Range Not Satisfiable");
      return;
    }
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
  console.log("\n🧹 cleanup request for TEMP_DIR");
  let deletedCount = 0;
  let failedCount = 0;
  try {
    const tempFiles = fs.readdirSync(TEMP_DIR);
    console.log("📁 found", tempFiles.length, "temp files:", tempFiles);

    tempFiles.forEach((file) => {
      try {
        fs.unlinkSync(path.join(TEMP_DIR, file));
        console.log("🗑️ deleted:", file);
        deletedCount++;
      } catch (unlinkErr) {
        console.warn(
          `⚠️ could not delete temp file: ${file}`,
          unlinkErr.message
        );
        failedCount++;
      }
    });

    const message = `Temp files cleanup attempted. Deleted: ${deletedCount}, Failed: ${failedCount}.`;
    console.log(`✅ ${message}`);
    res.json({ success: true, message });
  } catch (error) {
    console.log("❌ cleanup error:", error.message);
    res
      .status(500)
      .json({ success: false, error: "Error cleaning temp files" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("📁 Temp directory:", path.resolve(TEMP_DIR));
  console.log("📁 Uploads directory:", path.resolve(UPLOADS_DIR));
  console.log("🔐 Password protection:", !!PASSWORD);
});
