const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const transcodedFolder = process.env.TRANSCODED_FOLDER_PATH;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || "1");
const SEGMENT_DURATION = parseInt(process.env.SEGMENT_DURATION || "20");
const USE_HARDWARE_ACCELERATION =
  process.env.USE_HARDWARE_ACCELERATION !== "false"; // Default to true
const QUALITY_PRESET = process.env.QUALITY_PRESET || "medium";

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

function isResolutionTranscoded(fileName, resolution) {
  const resolutionDir = path.join(transcodedFolder, fileName, resolution);
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
    low: { crf: 28, preset: "faster" },
    medium: { crf: 23, preset: "medium" },
    high: { crf: 18, preset: "slow" },
  };
  return presets[preset] || presets.medium;
}

function determineResolutions(height) {
  const qualitySettings = getQualityPresetSettings(QUALITY_PRESET);
  const allResolutions = [
    { name: "480p", height: 480, bitrate: "1000k", ...qualitySettings },
    { name: "720p", height: 720, bitrate: "2500k", ...qualitySettings },
    { name: "1080p", height: 1080, bitrate: "5000k", ...qualitySettings },
    { name: "1440p", height: 1440, bitrate: "8000k", ...qualitySettings },
    { name: "2160p", height: 2160, bitrate: "16000k", ...qualitySettings },
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
  const masterPlaylistPath = path.join(outputDir, "master.m3u8");

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Initialize master playlist
  let masterPlaylist = ["#EXTM3U", "#EXT-X-VERSION:3"];

  // Write initial master playlist file
  fs.writeFileSync(masterPlaylistPath, masterPlaylist.join("\n"));

  // Get video metadata to determine original resolution
  const metadata = await getVideoMetadata(filePath);
  console.log(
    `Original video resolution: ${metadata.width}x${metadata.height}`
  );

  // Determine which resolutions to generate based on original
  const resolutions = determineResolutions(metadata.height);

  // Generate each resolution version that hasn't been transcoded
  for (const resolution of resolutions) {
    if (!isResolutionTranscoded(fileName, resolution.name)) {
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
        `Resolution ${resolution.name} for ${fileName} already exists. Skipping.`
      );
    }

    // Update master playlist file after each resolution
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

      if (resolution.height > metadata.height) {
        console.log(
          `Skipping ${resolution.name} for ${fileName} as it's higher than the original resolution.`
        );
        resolve();
        return;
      }
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

    command.inputOptions(["-hwaccel videotoolbox"]);

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
        "-b:a 128k",
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
        `-vf scale=${width}:${resolution.height}`,
        "-c:v libx264",
        `-b:v ${resolution.bitrate}`,
        `-preset ${resolution.preset}`,
        `-crf ${resolution.crf}`,
        "-profile:v main",
        "-c:a aac",
        "-ar 48000",
        "-b:a 128k",
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
