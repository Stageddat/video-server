const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const upload = require("../utils/multerConfig");
const videoController = require("../controllers/videoController");

router.post(
  "/upload",
  authMiddleware,
  upload.single("video"),
  videoController.handleUpload
);
router.get("/processing-status/:taskId", videoController.getProcessingStatus);
router.get("/videos", videoController.listVideos);
router.get("/video/:filename", videoController.streamVideo);
router.get("/embedVideo", videoController.embedVideo); // Re-added explicit embed route
router.get("/thumbnail/:filename", videoController.getThumbnail);
router.post("/cleanup", authMiddleware, videoController.cleanupTempFiles);

// New routes for editing and deleting videos
router.delete("/video/:filename", authMiddleware, videoController.deleteVideo);
router.post("/rename", authMiddleware, videoController.renameVideo);

module.exports = router;
