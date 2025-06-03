const path = require("path");
const fs = require("fs");
const {
  UPLOADS_DIR,
  THUMBNAILS_DIR,
  TEMP_DIR,
} = require("../../config/index.js");
const {
  safeUnlink,
  renameFile,
  fileExists,
  getFileSize,
  readDir,
} = require("../services/fileService.js");
const {
  processVideo,
  generateThumbnail,
  getTaskEventEmitter,
  cleanupTaskEmitter,
} = require("../services/videoProcessor.js");

const getUniqueFilename = (baseFilename, directory) => {
  let filename = baseFilename;
  let counter = 0;
  const fileExtension = path.extname(baseFilename);
  const nameWithoutExt = path.basename(baseFilename, fileExtension);

  while (fileExists(path.join(directory, filename))) {
    counter++;
    filename = `${nameWithoutExt}_${counter}${fileExtension}`;
  }
  return filename;
};

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
  const customName = req.body.customName;

  let desiredFilename;
  const fileExtension = path.extname(originalFilename) || ".mp4";

  if (customName) {
    const sanitizedCustomName = customName
      .replace(/[^a-zA-Z0-9-_\s.]/g, "_")
      .trim();
    desiredFilename = `${sanitizedCustomName.replace(
      new RegExp(`${fileExtension}$`, "i"),
      ""
    )}${fileExtension}`;
  } else {
    desiredFilename = originalFilename;
  }

  const finalNameForUploads = getUniqueFilename(desiredFilename, UPLOADS_DIR);

  const taskId =
    Date.now().toString() + Math.random().toString(36).substring(2, 7);

  const emitter = getTaskEventEmitter(taskId);

  if (req.isSpecialPassword) {
    const finalUploadsPath = path.join(UPLOADS_DIR, finalNameForUploads);

    try {
      renameFile(rawTempFilePath, finalUploadsPath);

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
        console.error(
          `Thumbnail generation failed for ${finalNameForUploads}:`,
          thumbError
        );
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

    processVideo(
      rawTempFilePath,
      processingTempFilePath,
      finalNameForUploads,
      taskId
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
    console.log(`[SSE] Task ${taskId} not found or already completed.`);
    return res
      .status(404)
      .json({ error: "Task not found or already completed." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",

    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    Pragma: "no-cache",
    Expires: "0",
    "Transfer-Encoding": "chunked",
    "Content-Encoding": "identity",
  });

  res.write(": connected\n\n");
  if (res.flush) res.flush();

  res.write("retry: 1000\n\n");
  if (res.flush) res.flush();

  console.log(
    `[SSE] Client connected for task ${taskId}. Sending initial status.`
  );

  const initialData = {
    stage: "started",
    progress: 0,
    message: "Processing started.",
  };
  res.write(`data: ${JSON.stringify(initialData)}\n\n`);
  if (res.flush) res.flush();

  const heartbeatInterval = setInterval(() => {
    console.log(`[SSE] Sending heartbeat for task ${taskId}.`);
    res.write(`: heartbeat ${Date.now()}\n\n`);
    if (res.flush) res.flush();
  }, 5000);

  const onProgress = (data) => {
    console.log(`[SSE] Task ${taskId} progress: ${JSON.stringify(data)}`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  const onDone = (data) => {
    console.log(`[SSE] Task ${taskId} done: ${JSON.stringify(data)}`);
    const responseData = {
      ...data,
      stage: "done",
      skippedProcessing: data.skippedProcessing || false,
    };
    res.write(`data: ${JSON.stringify(responseData)}\n\n`);
    if (res.flush) res.flush();
    res.end();
    clearInterval(heartbeatInterval);
    cleanupTaskEmitter(taskId, {
      progress: onProgress,
      done: onDone,
      error: onError,
    });
  };

  const onError = (data) => {
    console.error(`[SSE] Task ${taskId} error: ${JSON.stringify(data)}`);
    res.write(`data: ${JSON.stringify({ ...data, stage: "error" })}\n\n`);
    if (res.flush) res.flush();
    res.end();
    clearInterval(heartbeatInterval);
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
    console.log(`[SSE] Client disconnected for task ${taskId}. Cleaning up.`);
    clearInterval(heartbeatInterval);
    cleanupTaskEmitter(taskId, {
      progress: onProgress,
      done: onDone,
      error: onError,
    });
  });
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

const sendEmbedHtml = (req, res, filename) => {
  const videoPathInUploads = path.join(UPLOADS_DIR, filename);
  if (!fileExists(videoPathInUploads)) {
    return res.status(404).send("Video not found.");
  }

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const videoUrl = `${baseUrl}/video/${encodeURIComponent(filename)}`;
  const thumbnailName = filename.replace(/\.[^/.]+$/, ".jpg");
  const thumbnailUrl = `${baseUrl}/thumbnail/${encodeURIComponent(
    thumbnailName
  )}`;

  const videoWidth = 1280;
  const videoHeight = 720;
  const embedTitle = `Video: ${filename}`;
  const embedDescription = `Reproducir ${filename}`;

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${embedTitle}</title>
        <meta property="og:site_name" content="video hosting">
        <meta property="og:title" content="${embedTitle}">
        <meta property="og:description" content="${embedDescription}">
        <meta property="og:type" content="video.movie">
        <meta property="og:url" content="${baseUrl}/embedVideo?filename=${encodeURIComponent(
    filename
  )}">
        <meta property="og:image" content="${thumbnailUrl}">
        <meta property="og:image:width" content="${videoWidth}">
        <meta property="og:image:height" content="${videoHeight}">
        <meta property="og:video:url" content="${videoUrl}">
        <meta property="og:video:secure_url" content="${videoUrl}">
        <meta property="og:video:type" content="video/mp4">
        <meta property="og:video:width" content="${videoWidth}">
        <meta property="og:video:height" content="${videoHeight}">
        
        <meta name="twitter:card" content="player">
        <meta name="twitter:title" content="${embedTitle}">
        <meta name="twitter:description" content="${embedDescription}">
        <meta name="twitter:image" content="${thumbnailUrl}">
        <meta name="twitter:player" content="${videoUrl}">
        <meta name="twitter:player:width" content="${videoWidth}">
        <meta name="twitter:player:height" content="${videoHeight}">
        <meta name="twitter:app:name:iphone" content="video hosting">
        <meta name="twitter:app:name:ipad" content="video hosting">
        <meta name="twitter:app:name:googleplay" content="video hosting">

        <style>
            body {
                margin: 0;
                background-color: #1a1a1a;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                color: #f0f0f0;
                font-family: sans-serif;
            }
            video {
                max-width: 90%;
                max-height: 80vh;
                border-radius: 8px;
                box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
            }
            h1 {
                position: absolute;
                top: 20px;
                color: #f0f0f0;
                font-size: 1.5em;
            }
        </style>
    </head>
    <body>
        <h1>${embedTitle}</h1>
        <video controls autoplay muted>
            <source src="${videoUrl}" type="video/mp4">
            Tu navegador no soporta el elemento de video.
        </video>
    </body>
    </html>
  `);
};

const streamVideo = (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(UPLOADS_DIR, filename);

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

const embedVideo = (req, res) => {
  const { filename } = req.query;

  if (!filename) {
    return res.status(400).send("Filename is required for video embed.");
  }
  sendEmbedHtml(req, res, filename);
};

const deleteVideo = (req, res) => {
  const { filename } = req.params;
  const videoPath = path.join(UPLOADS_DIR, filename);
  const thumbnailName = filename.replace(/\.[^/.]+$/, ".jpg");
  const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);

  if (!fileExists(videoPath)) {
    return res
      .status(404)
      .json({ success: false, message: "Video not found." });
  }

  try {
    safeUnlink(videoPath, "DELETE_VIDEO", `video file: ${filename}`);
    safeUnlink(
      thumbnailPath,
      "DELETE_THUMBNAIL",
      `thumbnail file: ${thumbnailName}`
    );
    res.json({
      success: true,
      message: `Video '${filename}' and its thumbnail deleted successfully.`,
    });
  } catch (error) {
    console.error(`Error deleting video '${filename}':`, error);
    res.status(500).json({ success: false, message: "Error deleting video." });
  }
};

const renameVideo = (req, res) => {
  const { originalFilename, newName } = req.body;

  if (!originalFilename || !newName) {
    return res.status(400).json({
      success: false,
      message: "Original filename and new name are required.",
    });
  }

  const oldPath = path.join(UPLOADS_DIR, originalFilename);
  if (!fileExists(oldPath)) {
    return res
      .status(404)
      .json({ success: false, message: "Original video file not found." });
  }

  const fileExtension = path.extname(originalFilename) || ".mp4";
  const sanitizedNewName = newName.replace(/[^a-zA-Z0-9-_\s.]/g, "_").trim();
  let desiredNewFilename = `${sanitizedNewName.replace(
    new RegExp(`${fileExtension}$`, "i"),
    ""
  )}${fileExtension}`;

  const finalNewFilename = getUniqueFilename(desiredNewFilename, UPLOADS_DIR);
  const newPath = path.join(UPLOADS_DIR, finalNewFilename);

  try {
    renameFile(oldPath, newPath);

    const oldThumbName = originalFilename.replace(/\.[^/.]+$/, ".jpg");
    const newThumbName = finalNewFilename.replace(/\.[^/.]+$/, ".jpg");
    const oldThumbPath = path.join(THUMBNAILS_DIR, oldThumbName);
    const newThumbPath = path.join(THUMBNAILS_DIR, newThumbName);

    if (fileExists(oldThumbPath)) {
      try {
        renameFile(oldThumbPath, newThumbPath);
      } catch (thumbError) {
        console.error("Thumbnail rename error:", thumbError);
      }
    }

    res.json({
      success: true,
      message: `Video renamed to '${finalNewFilename}'.`,
      newFilename: finalNewFilename,
    });
  } catch (error) {
    console.error(`Error renaming video '${originalFilename}':`, error);
    res.status(500).json({ success: false, message: "Error renaming video." });
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
  listVideos,
  streamVideo,
  getThumbnail,
  cleanupTempFiles,
  embedVideo,
  deleteVideo,
  renameVideo,
};
