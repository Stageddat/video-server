const { exec, spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { safeUnlink } = require("./fileService");
const { UPLOADS_DIR, THUMBNAILS_DIR } = require("../config");

const taskProgressEmitters = {};

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
  finalFilename, // This is now the desired final name for the uploaded file
  taskId
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

        const finalUploadsPath = path.join(UPLOADS_DIR, finalFilename); // Use the finalFilename directly
        try {
          fs.renameSync(processingTempFilePath, finalUploadsPath);

          // Generate thumbnail
          const thumbnailName = finalFilename.replace(/\.[^/.]+$/, ".jpg");
          const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);

          try {
            await generateThumbnail(finalUploadsPath, thumbnailPath, taskId);
            emitter.emit("done", {
              filename: finalFilename, // Report the final filename
              thumbnail: thumbnailName,
              message: "Video processed successfully.",
            });
          } catch (thumbError) {
            console.error(
              `Thumbnail generation failed for ${finalFilename}:`,
              thumbError
            );
            emitter.emit("done", {
              filename: finalFilename, // Report the final filename
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

function getTaskEventEmitter(taskId) {
  if (!taskProgressEmitters[taskId]) {
    taskProgressEmitters[taskId] = new EventEmitter();
  }
  return taskProgressEmitters[taskId];
}

function cleanupTaskEmitter(taskId, listeners) {
  if (taskProgressEmitters[taskId]) {
    taskProgressEmitters[taskId].removeListener("progress", listeners.progress);
    taskProgressEmitters[taskId].removeListener("done", listeners.done);
    taskProgressEmitters[taskId].removeListener("error", listeners.error);
    if (
      taskProgressEmitters[taskId].listenerCount("progress") === 0 &&
      taskProgressEmitters[taskId].listenerCount("done") === 0 &&
      taskProgressEmitters[taskId].listenerCount("error") === 0
    ) {
      delete taskProgressEmitters[taskId];
    }
  }
}

module.exports = {
  processVideo,
  generateThumbnail,
  getTaskEventEmitter,
  cleanupTaskEmitter,
};
