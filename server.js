const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const dotenv = require("dotenv");
const EventEmitter = require("events");

dotenv.config();
const app = express();
const PORT = 80;
const PASSWORD = process.env.MASTER_PASSWORD;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TEMP_DIR = "temp/";
const UPLOADS_DIR = "uploads/";
const THUMBNAILS_DIR = "thumbnails/";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR);

const taskProgressEmitters = {};

function authMiddleware(req, res, next) {
  const providedPassword = req.headers.authorization;

  if (!providedPassword) {
    return res.status(401).json({
      success: false,
      error: "MISSING_PASSWORD",
      message: "password required",
    });
  }

  req.isSpecialPassword = providedPassword === process.env.SPECIAL_PASSWORD;

  if (
    !req.isSpecialPassword &&
    providedPassword !== process.env.MASTER_PASSWORD
  ) {
    return res.status(401).json({
      success: false,
      error: "WRONG_PASSWORD",
      message: "wrong password",
    });
  }

  next();
}

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

app.use(express.static("public"));

function safeUnlink(filePath, taskId, fileDescription) {
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(
        `[${taskId}] Error deleting ${fileDescription}:`,
        err.message
      );
    }
  }
}

async function generateThumbnail(videoPath, outputPath, taskId) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-i",
      videoPath,
      "-ss",
      "00:00:02",
      "-vframes",
      "1",
      "-vf",
      "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2",
      "-y",
      outputPath,
    ];

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(`Thumbnail generation failed with code ${code}`));
      }
    });

    ffmpegProcess.on("error", (err) => {
      reject(err);
    });
  });
}

async function processVideo(
  rawTempFilePath,
  processingTempFilePath,
  finalNameForUploads,
  taskId,
  originalFilename
) {
  const emitter = taskProgressEmitters[taskId];
  if (!emitter) {
    safeUnlink(rawTempFilePath, taskId, "Raw temp input file (no emitter)");
    return;
  }

  try {
    if (!fs.existsSync(rawTempFilePath)) {
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

    let totalDuration = 0;
    try {
      const stdout = await new Promise((resolve, reject) => {
        exec(probeCommand, (err, stdout, stderr) => {
          if (err) {
            return reject(new Error("PROBE_FAILED"));
          }
          resolve(stdout.trim());
        });
      });
      totalDuration = parseFloat(stdout);
      if (isNaN(totalDuration) || totalDuration <= 0)
        throw new Error("INVALID_DURATION");

      emitter.emit("progress", {
        stage: "probed_success",
        message: `Video duration: ${totalDuration.toFixed(
          2
        )}s. Starting conversion...`,
        duration: totalDuration,
      });
    } catch (probeError) {
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
      processingTempFilePath,
      "-y",
    ];

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

    ffmpegProcess.on("close", async (code) => {
      if (code === 0) {
        if (
          !fs.existsSync(processingTempFilePath) ||
          fs.statSync(processingTempFilePath).size === 0
        ) {
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
          fs.renameSync(processingTempFilePath, finalUploadsPath);

          // Generate thumbnail
          const thumbnailName = finalNameForUploads.replace(
            /\.[^/.]+$/,
            ".jpg"
          );
          const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);

          try {
            await generateThumbnail(finalUploadsPath, thumbnailPath, taskId);
            emitter.emit("done", {
              filename: finalNameForUploads,
              thumbnail: thumbnailName,
              message: "Video processed successfully.",
            });
          } catch (thumbError) {
            emitter.emit("done", {
              filename: finalNameForUploads,
              message:
                "Video processed successfully (thumbnail generation failed).",
            });
          }
        } catch (renameError) {
          emitter.emit("error", {
            message: "MOVE_FAILED",
            error: "Could not move processed video to final destination.",
          });
          safeUnlink(
            processingTempFilePath,
            taskId,
            "Processed temp file (move failed)"
          );
        }
      } else {
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
      safeUnlink(rawTempFilePath, taskId, "Raw temp input file (post-process)");
    });

    ffmpegProcess.on("error", (err) => {
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
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "NO_FILE",
        message: "No video file provided.",
      });
    }

    const rawTempFilePath = req.file.path;
    const originalFilename = req.file.originalname;
    const taskId =
      Date.now().toString() + Math.random().toString(36).substring(2, 7);

    taskProgressEmitters[taskId] = new EventEmitter();

    if (req.isSpecialPassword) {
      const finalTimestamp = Date.now();
      const finalNameForUploads = `${finalTimestamp}${
        path.extname(originalFilename) || ".mp4"
      }`;
      const finalUploadsPath = path.join(UPLOADS_DIR, finalNameForUploads);

      try {
        fs.renameSync(rawTempFilePath, finalUploadsPath);

        // Generate thumbnail for direct upload
        const thumbnailName = finalNameForUploads.replace(/\.[^/.]+$/, ".jpg");
        const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);

        try {
          await generateThumbnail(finalUploadsPath, thumbnailPath, taskId);
          taskProgressEmitters[taskId].emit("done", {
            filename: finalNameForUploads,
            thumbnail: thumbnailName,
            message: "File uploaded directly (special password).",
            skippedProcessing: true,
          });
        } catch (thumbError) {
          taskProgressEmitters[taskId].emit("done", {
            filename: finalNameForUploads,
            message: "File uploaded directly (thumbnail generation failed).",
            skippedProcessing: true,
          });
        }

        res.json({
          success: true,
          taskId: taskId,
          message: "Upload received, file moved directly.",
        });
      } catch (err) {
        taskProgressEmitters[taskId].emit("error", {
          message: "MOVE_FAILED",
          error: "Could not move file to uploads directory.",
        });
        safeUnlink(rawTempFilePath, taskId, "Raw temp file (move failed)");

        res.status(500).json({
          success: false,
          error: "MOVE_FAILED",
          message: "Error uploading file directly.",
          taskId: taskId,
        });
      }
    } else {
      const processingFileExt = path.extname(originalFilename) || ".mp4";
      const processingFileName = `processing_${taskId}${processingFileExt}`;
      const processingTempFilePath = path.join(TEMP_DIR, processingFileName);
      const finalNameForUploads = `${Date.now()}.mp4`;

      processVideo(
        rawTempFilePath,
        processingTempFilePath,
        finalNameForUploads,
        taskId,
        originalFilename
      ).catch((err) => {
        if (taskProgressEmitters[taskId]) {
          taskProgressEmitters[taskId].emit("error", {
            message: "ASYNC_PROCESS_ERROR",
            error: "Critical error in video processing.",
          });
        }
        safeUnlink(rawTempFilePath, taskId, "Raw temp file");
        safeUnlink(processingTempFilePath, taskId, "Processing temp file");
      });

      res.json({
        success: true,
        taskId: taskId,
        message: "Upload received, processing started.",
      });
    }
  }
);

app.get("/processing-status/:taskId", (req, res) => {
  const { taskId } = req.params;

  const emitter = taskProgressEmitters[taskId];
  if (!emitter) {
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
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onDone = (data) => {
    const responseData = {
      ...data,
      stage: "done",
      skippedProcessing: data.skippedProcessing || false,
    };
    res.write(`data: ${JSON.stringify(responseData)}\n\n`);
    res.end();
    cleanupTaskEmitter(taskId, {
      progress: onProgress,
      done: onDone,
      error: onError,
    });
  };

  const onError = (data) => {
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
        delete taskProgressEmitters[id];
      }
    }
  }

  emitter.on("progress", onProgress);
  emitter.on("done", onDone);
  emitter.on("error", onError);

  req.on("close", () => {
    cleanupTaskEmitter(taskId, {
      progress: onProgress,
      done: onDone,
      error: onError,
    });
  });
});

app.post("/rename", authMiddleware, (req, res) => {
  const { original, newName } = req.body;
  const oldPath = path.join(UPLOADS_DIR, original);
  const safeNewName = newName.replace(/[^a-zA-Z0-9-_\s.]/g, "_").trim();
  let finalNewName = safeNewName;
  if (!finalNewName.toLowerCase().endsWith(".mp4")) {
    finalNewName += ".mp4";
  }
  const newPath = path.join(UPLOADS_DIR, finalNewName);

  if (oldPath === newPath) {
    return res.json({
      success: true,
      newName: finalNewName,
      message: `File already has the name: ${finalNewName}`,
    });
  }

  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({
      success: false,
      error: "Original file not found. Was it processed correctly?",
    });
  }

  try {
    fs.renameSync(oldPath, newPath);

    // Rename thumbnail if exists
    const oldThumbName = original.replace(/\.[^/.]+$/, ".jpg");
    const newThumbName = finalNewName.replace(/\.[^/.]+$/, ".jpg");
    const oldThumbPath = path.join(THUMBNAILS_DIR, oldThumbName);
    const newThumbPath = path.join(THUMBNAILS_DIR, newThumbName);

    if (fs.existsSync(oldThumbPath)) {
      try {
        fs.renameSync(oldThumbPath, newThumbPath);
      } catch (thumbError) {
        // Ignore thumbnail rename errors
      }
    }

    res.json({
      success: true,
      newName: finalNewName,
      message: `Name changed to: ${finalNewName}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Error renaming file" });
  }
});

app.get("/videos", (req, res) => {
  try {
    const files = fs
      .readdirSync(UPLOADS_DIR)
      .filter((f) => f.toLowerCase().endsWith(".mp4"));
    const videosWithThumbnails = files.map((file) => {
      const thumbnailName = file.replace(/\.[^/.]+$/, ".jpg");
      const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);
      return {
        filename: file,
        thumbnail: fs.existsSync(thumbnailPath) ? thumbnailName : null,
      };
    });
    res.json(videosWithThumbnails);
  } catch (error) {
    res.status(500).json({ error: "Error listing videos" });
  }
});

app.get("/video/:filename", (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).send("Requested Range Not Satisfiable");
      return;
    }
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

app.get("/thumbnail/:filename", (req, res) => {
  const thumbnailPath = path.join(THUMBNAILS_DIR, req.params.filename);

  if (!fs.existsSync(thumbnailPath)) {
    return res.status(404).send("Thumbnail not found");
  }

  res.sendFile(path.resolve(thumbnailPath));
});

app.post("/cleanup", authMiddleware, (req, res) => {
  let deletedCount = 0;
  let failedCount = 0;
  try {
    const tempFiles = fs.readdirSync(TEMP_DIR);

    tempFiles.forEach((file) => {
      try {
        fs.unlinkSync(path.join(TEMP_DIR, file));
        deletedCount++;
      } catch (unlinkErr) {
        failedCount++;
      }
    });

    const message = `Temp files cleanup attempted. Deleted: ${deletedCount}, Failed: ${failedCount}.`;
    res.json({ success: true, message });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: "Error cleaning temp files" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("📁 Temp directory:", path.resolve(TEMP_DIR));
  console.log("📁 Uploads directory:", path.resolve(UPLOADS_DIR));
  console.log("📁 Thumbnails directory:", path.resolve(THUMBNAILS_DIR));
  console.log("🔐 Password protection:", !!PASSWORD);
});
