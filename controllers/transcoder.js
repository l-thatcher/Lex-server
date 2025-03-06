const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const transcodedFolder = process.env.TRANSCODED_FOLDER_PATH;

// Ensure transcoded folder exists
if (!fs.existsSync(transcodedFolder)) {
  fs.mkdirSync(transcodedFolder, { recursive: true });
}

function isVideoAlreadyTranscoded(fileName) {
  const outputDir = path.join(transcodedFolder, fileName);
  const masterPlaylistPath = path.join(outputDir, "master.m3u8");

  // Check if the master playlist exists
  if (fs.existsSync(masterPlaylistPath)) {
    // Check if all quality versions exist
    const resolutions = ["480p", "720p", "1080p"];
    const allResolutionsExist = resolutions.every((resolution) =>
      fs.existsSync(path.join(outputDir, resolution, "playlist.m3u8"))
    );
    return allResolutionsExist;
  }

  return false;
}

function isResolutionTranscoded(fileName, resolution) {
  const resolutionDir = path.join(transcodedFolder, fileName, resolution);
  const playlistPath = path.join(resolutionDir, "playlist.m3u8");
  return fs.existsSync(playlistPath);
}

function transcodeVideo(filePath) {
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

  const outputPath = path.join(outputDir, "playlist.m3u8");

  console.log(`Transcoding ${fileName} to HLS format...`);

  // Use FFmpeg to transcode the video to HLS format
  ffmpeg(filePath)
    .outputOptions([
      "-profile:v main",
      "-c:v h264",
      "-c:a aac",
      "-ar 48000",
      "-b:a 128k",
      "-hls_time 10", // 10-second segments
      "-hls_list_size 0", // Keep all segments in the playlist
      "-hls_segment_filename",
      `${outputDir}/segment_%03d.ts`,
      "-f hls", // HLS format
    ])
    .output(outputPath)
    .on("start", () => {
      console.log(`Started transcoding: ${fileName}`);
    })
    .on("progress", (progress) => {
      console.log(
        `Processing: ${fileName} - ${progress.percent.toFixed(2)}% done`
      );
    })
    .on("end", () => {
      console.log(`Finished transcoding: ${fileName}`);
      // Generate multiple quality versions for adaptive streaming
      generateAdaptiveBitrateVersions(filePath, fileName);
    })
    .on("error", (err) => {
      console.error(`Error transcoding ${fileName}:`, err);
    })
    .run();
}

function generateAdaptiveBitrateVersions(filePath, fileName) {
  const outputDir = path.join(transcodedFolder, fileName);
  const resolutions = [
    { name: "480p", height: 480, bitrate: "1000k" },
    { name: "720p", height: 720, bitrate: "2500k" },
    { name: "1080p", height: 1080, bitrate: "5000k" },
  ];

  // Create master playlist
  const masterPlaylist = ["#EXTM3U", "#EXT-X-VERSION:3"];

  // Add original quality to master playlist
  masterPlaylist.push(
    "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080"
  );
  masterPlaylist.push("playlist.m3u8");

  // Process each resolution
  resolutions.forEach((resolution) => {
    if (isResolutionTranscoded(fileName, resolution.name)) {
      console.log(
        `Resolution ${resolution.name} for ${fileName} already exists. Skipping.`
      );
      // Add to master playlist
      masterPlaylist.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${
          parseInt(resolution.bitrate) * 1000
        },RESOLUTION=${resolution.height}p`
      );
      masterPlaylist.push(`${resolution.name}/playlist.m3u8`);
      return;
    }

    const resolutionDir = path.join(outputDir, resolution.name);

    if (!fs.existsSync(resolutionDir)) {
      fs.mkdirSync(resolutionDir, { recursive: true });
    }

    const outputPath = path.join(resolutionDir, "playlist.m3u8");

    ffmpeg(filePath)
      .outputOptions([
        `-vf scale=-2:${resolution.height}`,
        "-c:v h264",
        `-b:v ${resolution.bitrate}`,
        "-c:a aac",
        "-ar 48000",
        "-b:a 128k",
        "-hls_time 10",
        "-hls_segment_filename",
        `${resolutionDir}/segment_%03d.ts`,
        "-f hls",
      ])
      .output(outputPath)
      .on("end", () => {
        console.log(`Finished transcoding ${fileName} to ${resolution.name}`);

        // Add to master playlist
        masterPlaylist.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${
            parseInt(resolution.bitrate) * 1000
          },RESOLUTION=${resolution.height}p`
        );
        masterPlaylist.push(`${resolution.name}/playlist.m3u8`);

        // Write master playlist file
        fs.writeFileSync(
          path.join(outputDir, "master.m3u8"),
          masterPlaylist.join("\n")
        );
      })
      .on("error", (err) => {
        console.error(
          `Error transcoding ${fileName} to ${resolution.name}:`,
          err
        );
      })
      .run();
  });
}

module.exports = {
  transcodeVideo,
};
