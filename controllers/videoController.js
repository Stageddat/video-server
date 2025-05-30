const path = require("path");
const fs = require("fs");
const { UPLOADS_DIR, THUMBNAILS_DIR, TEMP_DIR } = require("../config");
const {
  safeUnlink,
  renameFile,
  fileExists,
  getFileSize,
  readDir,
} = require("../services/fileService");
const {
  processVideo,
  generateThumbnail,
  getTaskEventEmitter,
  cleanupTaskEmitter,
} = require("../services/videoProcessor");

const handleUpload = async (req, res) => {
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

  const emitter = getTaskEventEmitter(taskId);

  if (req.isSpecialPassword) {
    const finalTimestamp = Date.now();
    const finalNameForUploads = `${finalTimestamp}${
      path.extname(originalFilename) || ".mp4"
    }`;
    const finalUploadsPath = path.join(UPLOADS_DIR, finalNameForUploads);

    try {
      renameFile(rawTempFilePath, finalUploadsPath);

      // Generate thumbnail for direct upload
      const thumbnailName = finalNameForUploads.replace(/\.[^/.]+$/, ".jpg");
      const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);

      try {
        await generateThumbnail(finalUploadsPath, thumbnailPath, taskId);
        emitter.emit("done", {
          filename: finalNameForUploads,
          thumbnail: thumbnailName,
          message: "File uploaded directly (special password).",
          skippedProcessing: true,
        });
      } catch (thumbError) {
        emitter.emit("done", {
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
      emitter.emit("error", {
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
      if (getTaskEventEmitter(taskId)) {
        getTaskEventEmitter(taskId).emit("error", {
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
};

const getProcessingStatus = (req, res) => {
  const { taskId } = req.params;

  const emitter = getTaskEventEmitter(taskId);
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
};

const renameVideo = (req, res) => {
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

  if (!fileExists(oldPath)) {
    return res.status(404).json({
      success: false,
      error: "Original file not found. Was it processed correctly?",
    });
  }

  try {
    renameFile(oldPath, newPath);

    // Rename thumbnail if exists
    const oldThumbName = original.replace(/\.[^/.]+$/, ".jpg");
    const newThumbName = finalNewName.replace(/\.[^/.]+$/, ".jpg");
    const oldThumbPath = path.join(THUMBNAILS_DIR, oldThumbName);
    const newThumbPath = path.join(THUMBNAILS_DIR, newThumbName);

    if (fileExists(oldThumbPath)) {
      try {
        renameFile(oldThumbPath, newThumbPath);
      } catch (thumbError) {
        // Ignore thumbnail rename errors
        console.error("Thumbnail rename error:", thumbError);
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
};

const listVideos = (req, res) => {
  try {
    const files = readDir(UPLOADS_DIR).filter((f) =>
      f.toLowerCase().endsWith(".mp4")
    );
    const videosWithThumbnails = files.map((file) => {
      const thumbnailName = file.replace(/\.[^/.]+$/, ".jpg");
      const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);
      return {
        filename: file,
        thumbnail: fileExists(thumbnailPath) ? thumbnailName : null,
      };
    });
    res.json(videosWithThumbnails);
  } catch (error) {
    res.status(500).json({ error: "Error listing videos" });
  }
};

const streamVideo = (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);

  if (!fileExists(filePath)) {
    return res.status(404).send("Video not found");
  }

  const fileSize = getFileSize(filePath);
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
};

const getThumbnail = (req, res) => {
  const thumbnailPath = path.join(THUMBNAILS_DIR, req.params.filename);

  if (!fileExists(thumbnailPath)) {
    return res.status(404).send("Thumbnail not found");
  }

  res.sendFile(path.resolve(thumbnailPath));
};

const cleanupTempFiles = (req, res) => {
  let deletedCount = 0;
  let failedCount = 0;
  try {
    const tempFiles = readDir(TEMP_DIR);

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
};

module.exports = {
  handleUpload,
  getProcessingStatus,
  renameVideo,
  listVideos,
  streamVideo,
  getThumbnail,
  cleanupTempFiles,
};
