const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const router = express.Router();
const transcodedFolder = process.env.TRANSCODED_FOLDER_PATH;

// Helper function to recursively get all video directories
function getVideoDirectories(dir) {
  let results = [];
  const items = fs.readdirSync(dir);

  items.forEach((item) => {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      // Check if this directory contains a master.m3u8 file
      if (fs.existsSync(path.join(fullPath, "master.m3u8"))) {
        // Get relative path from transcoded folder
        const relativePath = path.relative(transcodedFolder, fullPath);
        results.push(relativePath);
      } else {
        // Recursively search subdirectories
        results = results.concat(getVideoDirectories(fullPath));
      }
    }
  });

  return results;
}

// Get list of available videos
router.get("/videos", (req, res) => {
  try {
    const { category } = req.query;
    const videoDirectories = getVideoDirectories(transcodedFolder);

    let filteredVideos = videoDirectories.map((directory) => {
      const dirPath = path.join(transcodedFolder, directory);
      const parentDir = path.dirname(directory);
      const name = path.basename(directory);

      return {
        id: directory,
        name: name,
        category: parentDir !== "." ? parentDir : "uncategorized",
        thumbnail: `/videos/${directory}/thumbnail.jpg`,
        url: `/videos/${directory}/master.m3u8`,
      };
    });

    // Filter by category if provided
    if (category) {
      filteredVideos = filteredVideos.filter((video) =>
        video.category.toLowerCase().startsWith(category.toLowerCase())
      );
    }

    res.json(filteredVideos);
  } catch (error) {
    console.error("Error getting videos:", error);
    res.status(500).json({ error: "Failed to get videos" });
  }
});

// Get specific video details
router.get("/videos/:id(*)", (req, res) => {
  const videoId = req.params.id; // Will now contain the full relative path
  const videoPath = path.join(transcodedFolder, videoId);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: "Video not found" });
  }

  try {
    const name = path.basename(videoId);
    const parentDir = path.dirname(videoId);

    const video = {
      id: videoId,
      name: name,
      category: parentDir !== "." ? parentDir : "uncategorized",
      thumbnail: `/videos/${videoId}/thumbnail.jpg`,
      url: `/videos/${videoId}/master.m3u8`,
      resolutions: [],
    };

    // Check for available resolutions
    const resolutions = ["480p", "720p", "1080p", "1440p", "2160p"];
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
