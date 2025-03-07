const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");

// Keep track of processed folders to avoid duplicate processing
const processedFolders = new Set();

// Function to generate thumbnail from video file
function generateThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`Generating thumbnail from: ${videoPath}`);
    console.log(`Saving thumbnail to: ${outputPath}`);

    ffmpeg(videoPath)
      .screenshots({
        count: 1,
        folder: path.dirname(outputPath),
        filename: path.basename(outputPath),
        size: "640x360", // Reasonable size for thumbnails
      })
      .on("end", () => {
        console.log(`✓ Thumbnail created successfully: ${outputPath}`);
        resolve();
      })
      .on("error", (err) => {
        console.error(`✗ Error generating thumbnail: ${err.message}`);
        reject(err);
      });
  });
}

// Function to find the first video segment in the 480p folder
function findFirstVideoSegment(movieFolderPath) {
  const resolutionPath = path.join(movieFolderPath, "480p");

  if (!fs.existsSync(resolutionPath)) {
    return null;
  }

  try {
    const files = fs.readdirSync(resolutionPath);
    // Find the first .ts file (they should be named segment_XXX.ts)
    const videoSegment = files.find(
      (file) => file.endsWith(".ts") && file.startsWith("segment_03")
    );

    if (videoSegment) {
      return path.join(resolutionPath, videoSegment);
    }
    return null;
  } catch (err) {
    console.error(`Error reading directory ${resolutionPath}: ${err.message}`);
    return null;
  }
}

// Process a single movie folder
async function processMovieFolder(movieFolderPath) {
  const folderName = path.basename(movieFolderPath);

  // Skip if already processed
  if (processedFolders.has(movieFolderPath)) {
    return;
  }

  // Check if thumbnail already exists
  const thumbnailPath = path.join(movieFolderPath, "thumbnail.jpg");
  if (fs.existsSync(thumbnailPath)) {
    console.log(`Thumbnail already exists for ${folderName}, skipping.`);
    processedFolders.add(movieFolderPath);
    return;
  }

  // Find the first video segment
  const videoSegmentPath = findFirstVideoSegment(movieFolderPath);
  if (!videoSegmentPath) {
    console.log(
      `No video segments found in 480p folder for ${folderName}, will check again later.`
    );
    return;
  }

  // Generate thumbnail
  try {
    await generateThumbnail(videoSegmentPath, thumbnailPath);
    processedFolders.add(movieFolderPath);
  } catch (err) {
    console.error(
      `Failed to generate thumbnail for ${folderName}: ${err.message}`
    );
  }
}

// Scan existing folders on startup
function scanExistingFolders(transcodedFolderPath) {
  console.log("Scanning existing folders for missing thumbnails...");

  try {
    const folders = fs.readdirSync(transcodedFolderPath);

    folders.forEach((folderName) => {
      const folderPath = path.join(transcodedFolderPath, folderName);
      const stats = fs.statSync(folderPath);

      // Only process directories, not files
      if (stats.isDirectory()) {
        // Queue the folder for processing
        processMovieFolder(folderPath);
      }
    });
  } catch (err) {
    console.error(`Error scanning existing folders: ${err.message}`);
  }
}

// Initialize watcher
function initWatcher(transcodedFolderPath) {
  console.log(`Watching for new movie folders in: ${transcodedFolderPath}`);

  // Watch for new directories being created in the transcoded folder
  const watcher = chokidar.watch(transcodedFolderPath, {
    depth: 0, // Only watch the immediate subdirectories
    ignoreInitial: true, // Skip initial scan as we do it manually
    persistent: true,
    ignorePermissionErrors: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  // When a new directory is added
  watcher.on("addDir", (dirPath) => {
    // Skip if it's the base folder or a subdirectory of a movie folder
    if (
      dirPath === transcodedFolderPath ||
      path.dirname(dirPath) !== transcodedFolderPath
    ) {
      return;
    }

    console.log(`New movie folder detected: ${path.basename(dirPath)}`);
    processMovieFolder(dirPath);
  });

  // Also watch for changes in the 480p directories
  const watcherForSegments = chokidar.watch(`${transcodedFolderPath}/*/480p`, {
    ignoreInitial: true,
    persistent: true,
    depth: 1,
    ignorePermissionErrors: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  // When new files are added to 480p folders
  watcherForSegments.on("add", (filePath) => {
    // Only process .ts files
    if (!filePath.endsWith(".ts")) {
      return;
    }

    // Get movie folder path (two levels up from the segment file)
    const movieFolderPath = path.dirname(path.dirname(filePath));

    // Check if this is the first segment file
    if (
      filePath.includes("segment_001.ts") ||
      filePath.includes("segment_000.ts")
    ) {
      console.log(
        `First segment detected for ${path.basename(movieFolderPath)}`
      );
      processMovieFolder(movieFolderPath);
    }
  });

  console.log(
    "Thumbnail watchers initialized. Waiting for new folders and files..."
  );

  return {
    movieWatcher: watcher,
    segmentWatcher: watcherForSegments,
  };
}

// Main function to start the thumbnail generator
function watchForThumbnails() {
  const transcodedFolderPath = process.env.TRANSCODED_FOLDER_PATH;

  // First, scan existing folders
  scanExistingFolders(transcodedFolderPath);

  // Then start watching for new folders
  return initWatcher(transcodedFolderPath);
}

module.exports = {
  watchForThumbnails,
};
