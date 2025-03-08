const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const transcodedFolder = process.env.TRANSCODED_FOLDER_PATH;
const SEGMENT_DURATION = parseInt(process.env.SEGMENT_DURATION || "20");
const USE_HARDWARE_ACCELERATION =
  process.env.USE_HARDWARE_ACCELERATION !== "false"; // Default to true
const QUALITY_PRESET = process.env.QUALITY_PRESET || "medium";
const videoQueue = [];
let activeJobs = 0;
const cliProgress = require("cli-progress");
const os = require("os");
const MAX_CONCURRENT_JOBS =
  process.env.MAX_CONCURRENT_JOBS ||
  Math.max(1, Math.floor(os.cpus().length / 2));
const PRIORITY_ORDER = {
  "2160p": 1,
  "1440p": 2,
  "1080p": 3,
  "720p": 4,
  "480p": 5,
};
const { generateThumbnail } = require("../utils/thumbnailGenerator"); // Adjust relative path if needed

// Create a global multi progress bar instance
const multiBar = new cliProgress.MultiBar(
  {
    clearOnComplete: false,
    hideCursor: true,
    format: "[{bar}] {percentage}% | {file} | Frame: {frame} | Speed: {speed}",
    barCompleteChar: "█",
    barIncompleteChar: "░",
    forceRedraw: true,
    noTTYOutput: true,
    notTTYSchedule: 100,
  },
  cliProgress.Presets.shades_grey
);

// Ensure transcoded folder exists
if (!fs.existsSync(transcodedFolder)) {
  fs.mkdirSync(transcodedFolder, { recursive: true });
}

function isVideoAlreadyTranscoded(fileName, relativeDir = "") {
  const outputDir = path.join(transcodedFolder, relativeDir, fileName);
  const masterPlaylistPath = path.join(outputDir, "master.m3u8");

  if (fs.existsSync(masterPlaylistPath)) {
    const masterContent = fs.readFileSync(masterPlaylistPath, "utf8");
    const playlistLines = masterContent
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.trim().length > 0);

    return playlistLines.every((playlist) => {
      const playlistPath = path.join(outputDir, playlist);
      if (!fs.existsSync(playlistPath)) return false;

      const playlistContent = fs.readFileSync(playlistPath, "utf8");
      const segmentLines = playlistContent
        .split("\n")
        .filter((line) => line.endsWith(".ts"));

      return segmentLines.every((segment) =>
        fs.existsSync(path.join(path.dirname(playlistPath), segment))
      );
    });
  }

  return false;
}

function isResolutionTranscoded(fileName, resolution, relativeDir = "") {
  const resolutionDir = path.join(
    transcodedFolder,
    relativeDir,
    fileName,
    resolution
  );
  const playlistPath = path.join(resolutionDir, "playlist.m3u8");

  if (fs.existsSync(playlistPath)) {
    const playlistContent = fs.readFileSync(playlistPath, "utf8");
    const segmentLines = playlistContent
      .split("\n")
      .filter((line) => line.endsWith(".ts"));

    return (
      segmentLines.length > 0 &&
      segmentLines.every((segment) =>
        fs.existsSync(path.join(resolutionDir, segment))
      )
    );
  }
  return false;
}

function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(
        (stream) => stream.codec_type === "video"
      );
      if (!videoStream) {
        reject(new Error("No video stream found"));
        return;
      }

      resolve({
        width: videoStream.width,
        height: videoStream.height,
        duration: metadata.format.duration,
        bitrate: metadata.format.bit_rate,
      });
    });
  });
}

function getQualityPresetSettings(preset) {
  const presets = {
    low: { crf: 28, preset: "veryfast" },
    medium: { crf: 23, preset: "fast" },
    high: { crf: 18, preset: "medium" },
  };
  return presets[preset] || presets.medium;
}

function determineResolutions(height, width) {
  const qualitySettings = getQualityPresetSettings(QUALITY_PRESET);
  const allResolutions = [
    { name: "480p", height: 480, bitrate: "1000k", ...qualitySettings },
    { name: "720p", height: 720, bitrate: "2500k", ...qualitySettings },
    { name: "1080p", height: 1080, bitrate: "5000k", ...qualitySettings },
    { name: "1440p", height: 1440, bitrate: "8000k", ...qualitySettings },
    { name: "2160p", height: 2160, bitrate: "16000k", ...qualitySettings },
  ];

  // Find the next resolution level above the source height
  let nextLevelIndex = -1;
  for (let i = 0; i < allResolutions.length; i++) {
    if (allResolutions[i].height > height) {
      nextLevelIndex = i;
      break;
    }
  }

  // Return all resolutions up to and including one level above the source
  return allResolutions.filter(
    (res, index) =>
      res.height <= height ||
      (nextLevelIndex !== -1 && index === nextLevelIndex)
  );
}

async function transcodeVideo(filePath) {
  const relativePath = path.relative(process.env.VIDEO_FOLDER_PATH, filePath);
  const relativeDir = path.dirname(relativePath);

  // Get video metadata for priority calculation
  const metadata = await getVideoMetadata(filePath);
  const priority = calculatePriority(metadata);

  // Add to queue with priority
  return new Promise((resolve, reject) => {
    videoQueue.push({
      filePath,
      relativeDir,
      resolve,
      reject,
      priority,
      duration: metadata.duration,
      addedTime: Date.now(),
    });

    // Sort queue by duration first, then by resolution priority
    videoQueue.sort((a, b) => {
      if (a.duration !== b.duration) {
        return a.duration - b.duration; // Shortest first
      }
      return a.priority - b.priority; // Then by resolution priority
    });
    processQueue();
  });
}

function calculatePriority(metadata) {
  // Lower number = higher priority
  let priority = 100;

  // Prioritize by resolution
  const height = metadata.height;
  if (height >= 2160) priority = PRIORITY_ORDER["2160p"];
  else if (height >= 1440) priority = PRIORITY_ORDER["1440p"];
  else if (height >= 1080) priority = PRIORITY_ORDER["1080p"];
  else if (height >= 720) priority = PRIORITY_ORDER["720p"];
  else priority = PRIORITY_ORDER["480p"];

  return priority;
}

function processQueue() {
  if (videoQueue.length === 0 || activeJobs >= MAX_CONCURRENT_JOBS) {
    return;
  }

  activeJobs++;
  const { filePath, relativeDir, resolve, reject } = videoQueue.shift();

  processVideo(filePath, relativeDir)
    .then(resolve)
    .catch(reject)
    .finally(() => {
      activeJobs--;
      processQueue(); // Process next video in queue
    });
}

// Helper function to read and parse existing master playlist
function parseExistingMasterPlaylist(masterPlaylistPath) {
  if (!fs.existsSync(masterPlaylistPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(masterPlaylistPath, "utf8");
    const lines = content.split("\n");

    // Basic validation: Should contain #EXTM3U and at least one playlist
    if (!lines.some((line) => line.startsWith("#EXTM3U"))) {
      console.log(
        `Existing master playlist at ${masterPlaylistPath} seems invalid, will recreate`
      );
      return null;
    }

    // Extract existing playlists and their associated info
    const existingEntries = [];
    let currentStreamInfo = null;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        currentStreamInfo = line;
      } else if (currentStreamInfo && line.trim() && !line.startsWith("#")) {
        existingEntries.push({
          streamInfo: currentStreamInfo,
          playlist: line.trim(),
        });
        currentStreamInfo = null;
      }
    }

    // If we found valid entries, return them
    if (existingEntries.length > 0) {
      console.log(
        `Found ${existingEntries.length} existing resolution entries in master playlist`
      );
      return { lines, existingEntries };
    }

    return null;
  } catch (err) {
    console.error(`Error parsing master playlist: ${err.message}`);
    return null;
  }
}

// Helper function to backup existing master playlist
function backupMasterPlaylist(masterPlaylistPath) {
  if (!fs.existsSync(masterPlaylistPath)) {
    return;
  }

  const backupPath = `${masterPlaylistPath}.backup`;
  try {
    fs.copyFileSync(masterPlaylistPath, backupPath);
    console.log(`Backed up master playlist to ${backupPath}`);
  } catch (err) {
    console.error(`Failed to backup master playlist: ${err.message}`);
  }
}

async function processVideo(filePath, relativeDir = "") {
  // Replace spaces with dots in fileName
  const fileName = path
    .basename(filePath, path.extname(filePath))
    .replace(/\s+/g, ".");
  // Include fileName in the output folder path
  const outputDir = path.join(transcodedFolder, relativeDir, fileName);
  const masterPlaylistPath = path.join(outputDir, "master.m3u8");

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Check if a valid master playlist already exists and parse it
  let masterPlaylist;
  let existingPlaylistData = parseExistingMasterPlaylist(masterPlaylistPath);

  if (existingPlaylistData) {
    console.log(`Using existing master playlist for ${fileName}`);
    // Use header lines from existing playlist
    masterPlaylist = existingPlaylistData.lines.filter(
      (line) => line.startsWith("#") && !line.startsWith("#EXT-X-STREAM-INF:")
    );

    // Ensure essential headers exist
    if (!masterPlaylist.includes("#EXTM3U")) {
      masterPlaylist.unshift("#EXTM3U");
    }
    if (!masterPlaylist.includes("#EXT-X-VERSION:3")) {
      masterPlaylist.push("#EXT-X-VERSION:3");
    }

    // Create backup of the existing playlist
    backupMasterPlaylist(masterPlaylistPath);
  } else {
    // Initialize a new master playlist
    masterPlaylist = ["#EXTM3U", "#EXT-X-VERSION:3"];
    console.log(`Creating new master playlist for ${fileName}`);

    // Write initial master playlist file
    fs.writeFileSync(masterPlaylistPath, masterPlaylist.join("\n"));
  }

  // Get video metadata to determine original resolution
  const metadata = await getVideoMetadata(filePath);
  console.log(
    `Original video resolution: ${metadata.width}x${metadata.height}`
  );

  // Determine which resolutions to generate based on original
  const resolutions = determineResolutions(metadata.height, metadata.width);

  // Create a set of resolution names from the existing playlist entries
  const existingResolutions = new Set();
  if (existingPlaylistData && existingPlaylistData.existingEntries) {
    existingPlaylistData.existingEntries.forEach((entry) => {
      // Extract resolution folder name from playlist path
      const playlistPath = entry.playlist;
      const resolutionName = playlistPath.split("/")[0];
      existingResolutions.add(resolutionName);
    });
  }

  // Generate each resolution version that hasn't been transcoded
  for (const resolution of resolutions) {
    // Skip if this resolution is already in the master playlist
    // AND the resolution is actually transcoded fully
    if (
      existingResolutions.has(resolution.name) &&
      isResolutionTranscoded(fileName, resolution.name, relativeDir)
    ) {
      console.log(
        `Resolution ${resolution.name} for ${fileName} already exists in master playlist. Skipping.`
      );

      // Calculate aspect ratio-correct width for adding back to the playlist
      const aspectRatio = metadata.width / metadata.height;
      const width = Math.round(resolution.height * aspectRatio);

      // Add back the existing entry if it's not already in the working playlist
      const infoLine = `#EXT-X-STREAM-INF:BANDWIDTH=${
        parseInt(resolution.bitrate) * 1000
      },RESOLUTION=${width}x${resolution.height}`;
      const playlistLine = `${resolution.name}/playlist.m3u8`;

      // Only add if this exact entry isn't already in our working playlist
      if (
        !masterPlaylist.includes(infoLine) ||
        !masterPlaylist.includes(playlistLine)
      ) {
        masterPlaylist.push(infoLine);
        masterPlaylist.push(playlistLine);
      }

      continue;
    }

    if (!isResolutionTranscoded(fileName, resolution.name, relativeDir)) {
      console.log(`Transcoding ${fileName} to ${resolution.name}`);
      await generateResolutionVersion(
        filePath,
        fileName,
        resolution,
        masterPlaylist,
        metadata
      );
    } else {
      console.log(
        `Resolution ${resolution.name} for ${fileName} already exists but needs to be added to master playlist.`
      );

      // Calculate aspect ratio-correct width
      const aspectRatio = metadata.width / metadata.height;
      const width = Math.round(resolution.height * aspectRatio);

      // Add to master playlist
      masterPlaylist.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${
          parseInt(resolution.bitrate) * 1000
        },RESOLUTION=${width}x${resolution.height}`
      );
      masterPlaylist.push(`${resolution.name}/playlist.m3u8`);
    }

    // Update master playlist file after each resolution is processed
    fs.writeFileSync(masterPlaylistPath, masterPlaylist.join("\n"));
  }

  console.log(`Completed transcoding for ${fileName}`);
}

function generateResolutionVersion(
  filePath,
  fileName,
  resolution,
  masterPlaylist,
  metadata
) {
  return new Promise((resolve, reject) => {
    const relativePath = path.relative(process.env.VIDEO_FOLDER_PATH, filePath);
    const relativeDir = path.dirname(relativePath);
    // Include fileName in the output directory
    const outputDir = path.join(transcodedFolder, relativeDir, fileName);
    const resolutionDir = path.join(outputDir, resolution.name);

    if (isResolutionTranscoded(fileName, resolution.name, relativeDir)) {
      console.log(
        `Resolution ${resolution.name} for ${fileName} already exists. Skipping.`
      );

      // Add to master playlist
      const aspectRatio = metadata.width / metadata.height;
      const width = Math.round(resolution.height * aspectRatio);

      masterPlaylist.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${
          parseInt(resolution.bitrate) * 1000
        },RESOLUTION=${width}x${resolution.height}`
      );
      masterPlaylist.push(`${resolution.name}/playlist.m3u8`);

      if (resolution.height > metadata.height) {
        console.log(
          `Skipping ${resolution.name} for ${fileName} as it's higher than the original resolution.`
        );
        resolve();
        return;
      }
      resolve();
      return;
    }

    if (!fs.existsSync(resolutionDir)) {
      fs.mkdirSync(resolutionDir, { recursive: true });
    }

    const outputPath = path.join(resolutionDir, "playlist.m3u8");

    // Calculate aspect ratio-correct width
    const aspectRatio = metadata.width / metadata.height;
    const width = Math.round(resolution.height * aspectRatio);

    console.log(
      `Transcoding ${fileName} to ${resolution.name} (${width}x${resolution.height})`
    );

    // Try hardware acceleration first if enabled
    if (USE_HARDWARE_ACCELERATION) {
      tryHardwareAcceleration(
        filePath,
        fileName,
        resolution,
        resolutionDir,
        outputPath,
        width,
        masterPlaylist
      )
        .then(resolve)
        .catch((err) => {
          console.warn(
            `Hardware acceleration failed: ${err.message}. Falling back to software encoding.`
          );
          trySoftwareEncoding(
            filePath,
            fileName,
            resolution,
            resolutionDir,
            outputPath,
            width,
            masterPlaylist
          )
            .then(resolve)
            .catch(reject);
        });
    } else {
      // Use software encoding directly if hardware acceleration is disabled
      trySoftwareEncoding(
        filePath,
        fileName,
        resolution,
        resolutionDir,
        outputPath,
        width,
        masterPlaylist
      )
        .then(resolve)
        .catch(reject);
    }
  });
}

function tryHardwareAcceleration(
  filePath,
  fileName,
  resolution,
  resolutionDir,
  outputPath,
  width,
  masterPlaylist
) {
  const tempOutputPath = path.join(resolutionDir, "playlist.m3u8.tmp");
  return new Promise((resolve, reject) => {
    const command = ffmpeg(filePath);
    command.inputOptions(["-hwaccel videotoolbox"]);

    // Create a progress bar instance from the global multiBar
    const progressBar = multiBar.create(100, 0, {
      file: `${fileName} ${resolution.name}`,
      frame: 0,
      speed: "0fps",
    });

    command
      .outputOptions([
        `-vf scale=${width}:${resolution.height}`,
        "-c:v h264_videotoolbox",
        `-b:v ${resolution.bitrate}`,
        `-preset ${resolution.preset}`,
        `-crf ${resolution.crf}`,
        "-profile:v main",
        "-c:a aac",
        "-ar 48000",
        "-b:a 256k", // Increased audio bitrate for improved quality
        "-ac 2",
        `-hls_time ${SEGMENT_DURATION}`,
        "-hls_list_size 0",
        "-hls_segment_filename",
        `${resolutionDir}/segment_%03d.ts`,
        "-f hls",
        `-g 48`, // Optimize keyframe interval
        "-sc_threshold 0", // Disable scene change detection
        "-tune fastdecode",
        "-threads 0", // Let FFmpeg decide optimal thread count
        "-thread_type slice",
      ])
      .output(tempOutputPath)
      .on("start", () => {
        console.log(
          `Started transcoding ${fileName} to ${resolution.name} with hardware acceleration`
        );
      })
      .on("progress", (progress) => {
        const perc = Math.min(100, progress.percent || 0);
        progressBar.update(perc, {
          file: `${fileName} ${resolution.name}`,
          frame: progress.frames || 0,
          speed: progress.currentFps ? `${progress.currentFps}fps` : "0fps",
        });
      })
      .on("end", () => {
        progressBar.update(100);
        progressBar.stop();
        multiBar.remove(progressBar);
        console.log(
          `Finished transcoding ${fileName} to ${resolution.name} with hardware acceleration`
        );
        fs.renameSync(tempOutputPath, outputPath);
        masterPlaylist.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${
            parseInt(resolution.bitrate) * 1000
          },RESOLUTION=${width}x${resolution.height}`
        );
        masterPlaylist.push(`${resolution.name}/playlist.m3u8`);
        // Call generateThumbnail with the directory of the transcoded resolution
        generateThumbnail(resolutionDir);
        resolve();
      })
      .on("error", (err) => {
        progressBar.stop();
        // Remove the progress bar from multiBar
        multiBar.remove(progressBar);
        console.error(
          `Error transcoding ${fileName} to ${resolution.name} with hardware acceleration:`,
          err
        );
        if (fs.existsSync(tempOutputPath)) {
          fs.unlinkSync(tempOutputPath);
        }
        reject(err);
      })
      .run();
  });
}

function trySoftwareEncoding(
  filePath,
  fileName,
  resolution,
  resolutionDir,
  outputPath,
  width,
  masterPlaylist
) {
  const tempOutputPath = path.join(resolutionDir, "playlist.m3u8.tmp");
  return new Promise((resolve, reject) => {
    // Create a progress bar instance from the global multiBar
    const progressBar = multiBar.create(100, 0, {
      file: `${fileName} ${resolution.name}`,
      frame: 0,
      speed: "0fps",
    });

    ffmpeg(filePath)
      .outputOptions([
        `-vf scale=${width}:${resolution.height}`,
        "-c:v libx264",
        "-threads 0",
        `-b:v ${resolution.bitrate}`,
        `-preset ${resolution.preset}`,
        `-crf ${resolution.crf}`,
        "-profile:v main",
        "-c:a aac",
        "-ar 48000",
        "-b:a 256k", // Increased audio bitrate for improved quality
        "-ac 2",
        `-hls_time ${SEGMENT_DURATION}`,
        "-hls_list_size 0",
        "-hls_segment_filename",
        `${resolutionDir}/segment_%03d.ts`,
        "-f hls",
        `-g 48`, // Optimize keyframe interval
        "-sc_threshold 0", // Disable scene change detection
        "-tune fastdecode",
        "-threads 0", // Let FFmpeg decide optimal thread count
        "-thread_type slice",
      ])
      .output(tempOutputPath)
      .on("start", () => {
        console.log(
          `Started transcoding ${fileName} to ${resolution.name} with software encoding`
        );
      })
      .on("progress", (progress) => {
        const perc = Math.min(100, progress.percent || 0);
        progressBar.update(perc, {
          file: `${fileName} ${resolution.name}`,
          frame: progress.frames || 0,
          speed: progress.currentFps ? `${progress.currentFps}fps` : "0fps",
        });
      })
      .on("end", () => {
        progressBar.update(100);
        progressBar.stop();
        multiBar.remove(progressBar);
        console.log(
          `Finished transcoding ${fileName} to ${resolution.name} with software encoding`
        );
        fs.renameSync(tempOutputPath, outputPath);
        masterPlaylist.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${
            parseInt(resolution.bitrate) * 1000
          },RESOLUTION=${width}x${resolution.height}`
        );
        masterPlaylist.push(`${resolution.name}/playlist.m3u8`);
        // Call generateThumbnail with the directory of the transcoded resolution
        generateThumbnail(resolutionDir);
        resolve();
      })
      .on("error", (err) => {
        progressBar.stop();
        // Remove the progress bar from multiBar
        multiBar.remove(progressBar);
        console.error(
          `Error transcoding ${fileName} to ${resolution.name} with software encoding:`,
          err
        );
        if (fs.existsSync(tempOutputPath)) {
          fs.unlinkSync(tempOutputPath);
        }
        reject(err);
      })
      .run();
  });
}

module.exports = {
  transcodeVideo,
};
