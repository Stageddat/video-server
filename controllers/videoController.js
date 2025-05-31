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

// Function to find a unique filename by appending _X if it already exists
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
  const customName = req.body.customName; // Get custom name from the form data

  // Determine the final filename based on customName or originalFilename
  let desiredFilename;
  const fileExtension = path.extname(originalFilename) || ".mp4";
  const originalNameWithoutExt = path.parse(originalFilename).name;

  if (customName) {
    // Sanitize custom name: replace non-alphanumeric/dash/underscore/dot with underscore
    const sanitizedCustomName = customName
      .replace(/[^a-zA-Z0-9-_\s.]/g, "_")
      .trim();
    // Ensure the final name has the correct extension
    desiredFilename = `${sanitizedCustomName.replace(
      new RegExp(`${fileExtension}$`, "i"),
      ""
    )}${fileExtension}`;
  } else {
    // If no custom name, use the original filename directly.
    desiredFilename = originalFilename;
  }

  // Ensure the final filename is unique in the UPLOADS_DIR
  const finalNameForUploads = getUniqueFilename(desiredFilename, UPLOADS_DIR);

  const taskId =
    Date.now().toString() + Math.random().toString(36).substring(2, 7);

  const emitter = getTaskEventEmitter(taskId);

  if (req.isSpecialPassword) {
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
    const processingFileName = `processing_${taskId}${processingFileExt}`; // Temporary name during processing
    const processingTempFilePath = path.join(TEMP_DIR, processingFileName);

    processVideo(
      rawTempFilePath,
      processingTempFilePath,
      finalNameForUploads, // Pass the determined final unique name
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

/**
 * Generates and sends the HTML for Discord video embeds.
 * This function is used by both streamVideo (if Discordbot) and the dedicated /embedVideo route.
 */
const sendEmbedHtml = (req, res, filename) => {
  const videoPathInUploads = path.join(UPLOADS_DIR, filename);
  if (!fileExists(videoPathInUploads)) {
    return res.status(404).send("Video not found.");
  }

  // Construct full URLs for video and thumbnail
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const videoUrl = `${baseUrl}/video/${encodeURIComponent(filename)}`;
  const thumbnailName = filename.replace(/\.[^/.]+$/, ".jpg");
  const thumbnailUrl = `${baseUrl}/thumbnail/${encodeURIComponent(
    thumbnailName
  )}`;

  // Basic dimensions for the video embed.
  const videoWidth = 1280; // Placeholder, ideally get actual video dimensions
  const videoHeight = 720; // Placeholder, ideally get actual video dimensions
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
        <meta property="og:site_name" content="Tu Plataforma de Videos">
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
        <meta name="twitter:app:name:iphone" content="Tu Plataforma de Videos">
        <meta name="twitter:app:name:ipad" content="Tu Plataforma de Videos">
        <meta name="twitter:app:name:googleplay" content="Tu Plataforma de Videos">

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

/**
 * Streams the video file directly or serves an embed HTML page if requested by Discord.
 */
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

/**
 * Renders an HTML page with Open Graph meta tags for Discord video embeds.
 * This is the dedicated endpoint for embeds.
 */
const embedVideo = (req, res) => {
  const { filename } = req.query;

  if (!filename) {
    return res.status(400).send("Filename is required for video embed.");
  }
  sendEmbedHtml(req, res, filename);
};

/**
 * Deletes a video file and its corresponding thumbnail.
 */
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

/**
 * Renames a video file and its corresponding thumbnail.
 */
const renameVideo = (req, res) => {
  const { originalFilename, newName } = req.body; // originalFilename is the current name, newName is the desired new name

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
  // Sanitize new name and ensure it has the correct extension
  const sanitizedNewName = newName.replace(/[^a-zA-Z0-9-_\s.]/g, "_").trim();
  let desiredNewFilename = `${sanitizedNewName.replace(
    new RegExp(`${fileExtension}$`, "i"),
    ""
  )}${fileExtension}`;

  // Get a unique filename in case the desired new name already exists
  const finalNewFilename = getUniqueFilename(desiredNewFilename, UPLOADS_DIR);
  const newPath = path.join(UPLOADS_DIR, finalNewFilename);

  try {
    renameFile(oldPath, newPath);

    // Rename thumbnail if exists
    const oldThumbName = originalFilename.replace(/\.[^/.]+$/, ".jpg");
    const newThumbName = finalNewFilename.replace(/\.[^/.]+$/, ".jpg");
    const oldThumbPath = path.join(THUMBNAILS_DIR, oldThumbName);
    const newThumbPath = path.join(THUMBNAILS_DIR, newThumbName);

    if (fileExists(oldThumbPath)) {
      try {
        renameFile(oldThumbPath, newThumbPath);
      } catch (thumbError) {
        console.error("Thumbnail rename error:", thumbError);
        // Do not fail the main video rename if thumbnail rename fails
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
