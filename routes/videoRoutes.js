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
router.post("/rename", authMiddleware, videoController.renameVideo);
router.get("/videos", videoController.listVideos);
router.get("/video/:filename", videoController.streamVideo);
router.get("/thumbnail/:filename", videoController.getThumbnail);
router.post("/cleanup", authMiddleware, videoController.cleanupTempFiles);

module.exports = router;
