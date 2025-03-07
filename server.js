const express = require("express");
const cors = require("cors");
const path = require("path");
const videoRoutes = require("./routes/videos");
const fileWatcher = require("./utils/fileWatcher");
const thumbnailGenerator = require("./utils/thumbnailGenerator"); // Import the thumbnail generator
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from the transcoded folder
app.use("/videos", express.static(process.env.TRANSCODED_FOLDER_PATH));

// API routes
app.use("/api", videoRoutes);

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Start watching the video folder for new videos to transcode
  fileWatcher.watchFolder();

  // Start watching the transcoded folder for thumbnail generation
  thumbnailGenerator.watchForThumbnails();
});
