const fs = require("fs");
const path = require("path");

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

function renameFile(oldPath, newPath) {
  fs.renameSync(oldPath, newPath);
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function getFileSize(filePath) {
  return fs.statSync(filePath).size;
}

function readDir(directoryPath) {
  return fs.readdirSync(directoryPath);
}

module.exports = {
  safeUnlink,
  renameFile,
  fileExists,
  getFileSize,
  readDir,
};
