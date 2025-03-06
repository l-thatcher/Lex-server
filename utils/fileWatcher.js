const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const transcoder = require("../controllers/transcoder");
require("dotenv").config();

const videoFolder = process.env.VIDEO_FOLDER_PATH;
const supportedFormats = [".mp4", ".mkv", ".avi", ".mov", ".wmv"];

function watchFolder() {
  console.log(`Watching folder: ${videoFolder}`);

  // Initialize watcher
  const watcher = chokidar.watch(videoFolder, {
    ignored: /(^|[\/\\])\../, // Ignore dot files
    persistent: true,
  });

  // Add event listeners
  watcher.on("add", (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (supportedFormats.includes(ext)) {
      console.log(`New video detected: ${filePath}`);
      transcoder.transcodeVideo(filePath);
    }
  });

  return watcher;
}

module.exports = {
  watchFolder,
};
