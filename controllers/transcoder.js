const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const transcodedFolder = process.env.TRANSCODED_FOLDER_PATH;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || "1");
const SEGMENT_DURATION = parseInt(process.env.SEGMENT_DURATION || "10");
const USE_HARDWARE_ACCELERATION =
  process.env.USE_HARDWARE_ACCELERATION !== "false"; // Default to true

// Queue for processing videos sequentially
const videoQueue = [];
let activeJobs = 0;

// Ensure transcoded folder exists
if (!fs.existsSync(transcodedFolder)) {
  fs.mkdirSync(transcodedFolder, { recursive: true });
}

function isVideoAlreadyTranscoded(fileName) {
  const outputDir = path.join(transcodedFolder, fileName);
  const masterPlaylistPath = path.join(outputDir, "master.m3u8");

  // Check if the master playlist exists
  if (fs.existsSync(masterPlaylistPath)) {
    // Read master playlist to check what resolutions were created
    const masterContent = fs.readFileSync(masterPlaylistPath, "utf8");
    const playlistLines = masterContent
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.trim().length > 0);

    // Check if all referenced playlists exist
    return playlistLines.every((playlist) => {
      return fs.existsSync(path.join(outputDir, playlist));
    });
  }

  return false;
}

function isResolutionTranscoded(fileName, resolution) {
  const resolutionDir = path.join(transcodedFolder, fileName, resolution);
  const playlistPath = path.join(resolutionDir, "playlist.m3u8");
  return fs.existsSync(playlistPath);
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

function determineResolutions(height) {
  // Only include resolutions that are lower than or equal to the original
  const allResolutions = [
    { name: "480p", height: 480, bitrate: "1000k" },
    { name: "720p", height: 720, bitrate: "2500k" },
    { name: "1080p", height: 1080, bitrate: "5000k" },
  ];

  return allResolutions.filter((res) => res.height <= height);
}

async function transcodeVideo(filePath) {
  // Add to queue and process if no active jobs
  return new Promise((resolve, reject) => {
    videoQueue.push({ filePath, resolve, reject });
    processQueue();
  });
}

function processQueue() {
  if (videoQueue.length === 0 || activeJobs >= MAX_CONCURRENT_JOBS) {
    return;
  }

  activeJobs++;
  const { filePath, resolve, reject } = videoQueue.shift();

  processVideo(filePath)
    .then(resolve)
    .catch(reject)
    .finally(() => {
      activeJobs--;
      processQueue(); // Process next video in queue
    });
}

async function processVideo(filePath) {
  const fileName = path.basename(filePath, path.extname(filePath));
  const outputDir = path.join(transcodedFolder, fileName);

  if (isVideoAlreadyTranscoded(fileName)) {
    console.log(`Video ${fileName} has already been transcoded. Skipping.`);
    return;
  }

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Get video metadata to determine original resolution
  const metadata = await getVideoMetadata(filePath);
  console.log(
    `Original video resolution: ${metadata.width}x${metadata.height}`
  );

  // Determine which resolutions to generate based on original
  const resolutions = determineResolutions(metadata.height);
  console.log(
    `Will generate the following resolutions: ${resolutions
      .map((r) => r.name)
      .join(", ")}`
  );

  // Create master playlist
  const masterPlaylist = ["#EXTM3U", "#EXT-X-VERSION:3"];

  // Generate each resolution version
  for (const resolution of resolutions) {
    await generateResolutionVersion(
      filePath,
      fileName,
      resolution,
      masterPlaylist,
      metadata
    );
  }

  // Write master playlist file
  fs.writeFileSync(
    path.join(outputDir, "master.m3u8"),
    masterPlaylist.join("\n")
  );

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
    const outputDir = path.join(transcodedFolder, fileName);
    const resolutionDir = path.join(outputDir, resolution.name);

    if (isResolutionTranscoded(fileName, resolution.name)) {
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
  return new Promise((resolve, reject) => {
    const command = ffmpeg(filePath);

    // Apply hardware acceleration options to the INPUT
    command.inputOptions(["-hwaccel videotoolbox"]);

    // Apply output options separately
    command
      .outputOptions([
        // Video scaling
        `-vf scale=${width}:${resolution.height}`,

        // Video codec settings
        "-c:v h264_videotoolbox", // Use VideoToolbox hardware encoder
        `-b:v ${resolution.bitrate}`,
        "-profile:v main",

        // Audio settings
        "-c:a aac",
        "-ar 48000",
        "-b:a 128k",

        // HLS settings
        `-hls_time ${SEGMENT_DURATION}`,
        "-hls_list_size 0",
        "-hls_segment_filename",
        `${resolutionDir}/segment_%03d.ts`,
        "-f hls",
      ])
      .output(outputPath)
      .on("start", () => {
        console.log(
          `Started transcoding ${fileName} to ${resolution.name} with hardware acceleration`
        );
      })
      .on("progress", (progress) => {
        console.log(
          `Processing: ${fileName} (${resolution.name}) - ${
            progress.percent ? progress.percent.toFixed(2) : "0"
          }% done`
        );
      })
      .on("end", () => {
        console.log(
          `Finished transcoding ${fileName} to ${resolution.name} with hardware acceleration`
        );

        // Add to master playlist
        masterPlaylist.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${
            parseInt(resolution.bitrate) * 1000
          },RESOLUTION=${width}x${resolution.height}`
        );
        masterPlaylist.push(`${resolution.name}/playlist.m3u8`);

        resolve();
      })
      .on("error", (err) => {
        console.error(
          `Error transcoding ${fileName} to ${resolution.name} with hardware acceleration:`,
          err
        );
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
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions([
        // Video scaling
        `-vf scale=${width}:${resolution.height}`,

        // Video codec settings (software)
        "-c:v libx264",
        `-b:v ${resolution.bitrate}`,
        "-preset medium", // Balance between speed and quality
        "-profile:v main",

        // Audio settings
        "-c:a aac",
        "-ar 48000",
        "-b:a 128k",

        // HLS settings
        `-hls_time ${SEGMENT_DURATION}`,
        "-hls_list_size 0",
        "-hls_segment_filename",
        `${resolutionDir}/segment_%03d.ts`,
        "-f hls",
      ])
      .output(outputPath)
      .on("start", () => {
        console.log(
          `Started transcoding ${fileName} to ${resolution.name} with software encoding`
        );
      })
      .on("progress", (progress) => {
        console.log(
          `Processing: ${fileName} (${resolution.name}) - ${
            progress.percent ? progress.percent.toFixed(2) : "0"
          }% done`
        );
      })
      .on("end", () => {
        console.log(
          `Finished transcoding ${fileName} to ${resolution.name} with software encoding`
        );

        // Add to master playlist
        masterPlaylist.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${
            parseInt(resolution.bitrate) * 1000
          },RESOLUTION=${width}x${resolution.height}`
        );
        masterPlaylist.push(`${resolution.name}/playlist.m3u8`);

        resolve();
      })
      .on("error", (err) => {
        console.error(
          `Error transcoding ${fileName} to ${resolution.name} with software encoding:`,
          err
        );
        reject(err);
      })
      .run();
  });
}

module.exports = {
  transcodeVideo,
};
