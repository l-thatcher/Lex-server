const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const router = express.Router();
const transcodedFolder = process.env.TRANSCODED_FOLDER_PATH;

// Get list of available videos
router.get("/videos", (req, res) => {
  try {
    const videos = fs
      .readdirSync(transcodedFolder)
      .filter((file) =>
        fs.statSync(path.join(transcodedFolder, file)).isDirectory()
      )
      .map((folder) => {
        return {
          id: folder,
          name: folder,
          thumbnail: `/videos/${folder}/thumbnail.jpg`,
          url: `/videos/${folder}/master.m3u8`,
        };
      });

    res.json(videos);
  } catch (error) {
    console.error("Error getting videos:", error);
    res.status(500).json({ error: "Failed to get videos" });
  }
});

// Get specific video details
router.get("/videos/:id", (req, res) => {
  const videoId = req.params.id;
  const videoPath = path.join(transcodedFolder, videoId);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: "Video not found" });
  }

  try {
    const video = {
      id: videoId,
      name: videoId,
      thumbnail: `/videos/${videoId}/thumbnail.jpg`,
      url: `/videos/${videoId}/master.m3u8`,
      resolutions: ["original"],
    };

    // Check for available resolutions
    const resolutions = ["480p", "720p", "1080p"];
    resolutions.forEach((resolution) => {
      if (fs.existsSync(path.join(videoPath, resolution))) {
        video.resolutions.push(resolution);
      }
    });

    res.json(video);
  } catch (error) {
    console.error(`Error getting video ${videoId}:`, error);
    res.status(500).json({ error: "Failed to get video details" });
  }
});

module.exports = router;
