const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// API endpoints
const MP3_API = "https://backendmix.vercel.app/mp3";
const CHANNEL_API = "https://backendmix-emergeny.vercel.app/list";

// Configuration
const TEMP_DOWNLOAD_DIR = path.join(__dirname, "..", "temp_downloads");
const DOWNLOADS_JSON = path.join(__dirname, "..", "downloads.json");
const MAX_RETRIES = 3;
const CHANNEL_ID = "UCyBzV_g6Vfv5GM3aMQb3Y_A"; // Hardcoded Channel ID

// Internet Archive configuration
const IA_IDENTIFIER = "akkidark";
const IA_ACCESS_KEY = "cCYXD3V4ke4YkXLI";
const IA_SECRET_KEY = "qZHSAtgw5TJXkpZa";
const IA_BASE_URL = `https://archive.org/serve/${IA_IDENTIFIER}/`;

// Ensure the download directory exists
fs.ensureDirSync(TEMP_DOWNLOAD_DIR);

// Load existing downloads data
let downloadsData = {};
if (fs.existsSync(DOWNLOADS_JSON)) {
    try {
        downloadsData = JSON.parse(fs.readFileSync(DOWNLOADS_JSON, "utf-8"));
        console.log(`📋 Loaded ${Object.keys(downloadsData).length} existing downloads from JSON`);
    } catch (err) {
        console.error("❌ Failed to load downloads.json, resetting file.");
        downloadsData = {};
    }
}

/**
 * Upload a file to Internet Archive
 * @param {string} filePath Path to the file to upload
 * @param {string} videoId YouTube video ID
 * @param {string} title Video title
 * @returns {boolean} True if upload successful
 */
async function uploadToInternetArchive(filePath, videoId, title) {
    try {
        console.log(`📤 Uploading ${path.basename(filePath)} to Internet Archive...`);
        
        // Create Python script for upload
        const pythonScript = `
import os
import sys
import internetarchive

# Get file info
filepath = sys.argv[1]
video_id = sys.argv[2]
title = sys.argv[3]
filename = os.path.basename(filepath)

# Internet Archive credentials
access_key = "${IA_ACCESS_KEY}"
secret_key = "${IA_SECRET_KEY}"
identifier = "${IA_IDENTIFIER}"

# Upload file
response = internetarchive.upload(
    identifier=identifier,
    files=[filepath],
    metadata={
        "title": title,
        "mediatype": "audio",
        "collection": "opensource_audio",
        "creator": "YouTube Clone - ShradhaKD",
        "youtube_id": video_id
    },
    config={
        "s3": {
            "access": access_key,
            "secret": secret_key
        }
    },
    verbose=True
)

# Check if successful
success = True
for r in response:
    if r.status_code != 200:
        print(f"❌ Upload failed with status {r.status_code}: {r.text}")
        success = False
    else:
        print(f"✅ Successfully uploaded {filename}")

# Exit with appropriate code
sys.exit(0 if success else 1)
`;

        const scriptPath = path.join(TEMP_DOWNLOAD_DIR, "upload_script.py");
        fs.writeFileSync(scriptPath, pythonScript);
        
        // Run Python upload script
        const result = spawnSync("python", [scriptPath, filePath, videoId, title], {
            encoding: "utf-8",
            stdio: "inherit"
        });
        
        return result.status === 0;
    } catch (err) {
        console.error(`❌ Error uploading to Internet Archive: ${err.message}`);
        return false;
    }
}

/**
 * Commit changes to the downloads.json file
 */
function commitChangesToJson() {
    try {
        execSync("git config --global user.name 'github-actions'");
        execSync("git config --global user.email 'github-actions@github.com'");
        execSync(`git add "${DOWNLOADS_JSON}"`);
        execSync(`git commit -m "Update downloads.json with newly processed videos"`);
        execSync("git push");
        console.log(`📤 Committed and pushed updates to downloads.json`);
    } catch (err) {
        console.error("❌ Error committing file:", err.message);
    }
}

/**
 * Main function to download videos and upload to Internet Archive
 */
(async () => {
    try {
        console.log(`🔍 Fetching videos for channel ID: ${CHANNEL_ID}...`);
        const response = await axios.get(`${CHANNEL_API}/${CHANNEL_ID}`);

        if (!response.data || !response.data.videos || response.data.videos.length === 0) {
            console.error("❌ No videos found for this channel.");
            process.exit(1);
        }

        const videoIds = response.data.videos;
        console.log(`📹 Found ${videoIds.length} videos, checking which ones need processing...`);

        let processedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const videoId of videoIds) {
            const filename = `${videoId}.webm`;
            const filePath = path.join(TEMP_DOWNLOAD_DIR, filename);

            // Skip if already in our records
            if (downloadsData[videoId] && downloadsData[videoId].filePath) {
                console.log(`⏭️ Skipping ${videoId}, already processed`);
                skippedCount++;
                continue;
            }

            console.log(`🎵 Processing video ${videoId}...`);

            let success = false;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    console.log(`🔄 Download attempt ${attempt}/${MAX_RETRIES}...`);

                    // Get the download URL and filename from the MP3 API
                    const downloadResponse = await axios.get(`${MP3_API}/${videoId}`);
                    const { url, filename: videoTitle } = downloadResponse.data;

                    if (!url) {
                        throw new Error("No download URL returned from API");
                    }

                    // Clean up filename to use as title (remove .mp3 extension if present)
                    const title = videoTitle 
                        ? videoTitle.replace(/\.mp3$/, '').trim() 
                        : `Video ${videoId}`;

                    // Download the audio file
                    const writer = fs.createWriteStream(filePath);
                    const audioResponse = await axios({
                        url,
                        method: "GET",
                        responseType: "stream",
                        timeout: 60000
                    });

                    audioResponse.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on("finish", resolve);
                        writer.on("error", reject);
                    });

                    // Get file size
                    const fileSize = fs.statSync(filePath).size;

                    if (fileSize === 0) {
                        throw new Error("Downloaded file size is 0 bytes");
                    }

                    console.log(`✅ Downloaded ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
                    console.log(`📝 Title: ${title}`);

                    // Upload to Internet Archive
                    const uploadSuccess = await uploadToInternetArchive(filePath, videoId, title);
                    
                    if (!uploadSuccess) {
                        throw new Error("Failed to upload to Internet Archive");
                    }

                    // Update downloads.json with Internet Archive link
                    const iaFilePath = `${IA_BASE_URL}${filename}`;
                    downloadsData[videoId] = {
                        title: title,
                        id: videoId,
                        filePath: iaFilePath,
                        size: fileSize,
                        uploadDate: new Date().toISOString()
                    };

                    fs.writeFileSync(DOWNLOADS_JSON, JSON.stringify(downloadsData, null, 2));
                    console.log(`📝 Updated downloads.json with ${videoId}`);

                    // Remove local file after upload
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Removed local file ${filePath}`);
                    
                    processedCount++;
                    success = true;
                    break;
                } catch (err) {
                    console.error(`⚠️ Error processing ${videoId}: ${err.message}`);
                    
                    // Clean up partial download if it exists
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            console.log(`🗑️ Removed failed download: ${filePath}`);
                        } catch (cleanupErr) {
                            console.error(`⚠️ Failed to clean up file: ${cleanupErr.message}`);
                        }
                    }
                    
                    if (attempt === MAX_RETRIES) {
                        console.error(`❌ Failed after ${MAX_RETRIES} attempts, skipping.`);
                        errorCount++;
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            if (!success) {
                console.error(`🚨 Skipped: ${videoId} due to repeated errors.`);
            }
        }

        // Commit changes to downloads.json
        if (processedCount > 0) {
            commitChangesToJson();
        }

        console.log(`\n📊 Summary:`);
        console.log(`✅ Successfully processed: ${processedCount} videos`);
        console.log(`⏭️ Skipped (already processed): ${skippedCount} videos`);
        console.log(`❌ Failed: ${errorCount} videos`);
        console.log(`🌐 Internet Archive collection: https://archive.org/details/${IA_IDENTIFIER}`);

    } catch (error) {
        console.error("❌ Error:", error.message);
        process.exit(1);
    } finally {
        // Clean up any remaining files in temp directory
        try {
            const tempFiles = fs.readdirSync(TEMP_DOWNLOAD_DIR)
                .filter(file => file.endsWith('.webm'));
            
            if (tempFiles.length > 0) {
                console.log(`🧹 Cleaning up ${tempFiles.length} temporary files...`);
                tempFiles.forEach(file => {
                    const filePath = path.join(TEMP_DOWNLOAD_DIR, file);
                    fs.unlinkSync(filePath);
                });
            }
        } catch (err) {
            console.error(`⚠️ Error during cleanup: ${err.message}`);
        }
    }
})();
