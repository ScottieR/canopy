import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure process.env.MESHY_API_KEY is available or use a fallback test key if possible.
const MESHY_API_KEY = process.env.MESHY_API_KEY;

if (!MESHY_API_KEY) {
  console.error("Missing MESHY_API_KEY environment variable. Using test mode via meshy.ai dummy key if it works, otherwise this will fail.");
}

// Fallback to test key if user does not set one (based on web search for test mode keys)
// "msy_dummy_api_key_for_test_mode_12345678"
const API_KEY = MESHY_API_KEY || "msy_dummy_api_key_for_test_mode_12345678";
const HEADERS = {
  "Authorization": `Bearer ${API_KEY}`,
  "Content-Type": "application/json"
};

const LOBSTERS = [
  "Accountant.png",
  "Assistant.png",
  "Strategist.png",
  "Researcher.png",
  "Tutor.png"
];

const SOURCE_DIR = path.join(__dirname, '../public/agents');
const TARGET_DIR = path.join(__dirname, '../public/models/lobsters');

if (!fs.existsSync(TARGET_DIR)) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

function imageToBase64Uri(filePath) {
  const data = fs.readFileSync(filePath);
  const base64 = data.toString('base64');
  return `data:image/png;base64,${base64}`;
}

async function startMeshyTask(imageUrl) {
  const response = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      image_url: imageUrl,
      enable_pbr: true,
      topology: "quad",     // Best for characters
      target_polycount: 30000 
    })
  });
  
  const text = await response.text();
  console.log("Raw Meshy response:", text);

  if (!response.ok) {
    throw new Error(`Failed to start task: ${text}`);
  }

  const data = JSON.parse(text);
  return data.result; // task_id
}

async function pollMeshyTask(taskId, fileName) {
  let attempt = 0;
  while (attempt < 120) { // Max wait ~ 20 mins
    attempt++;
    const response = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`, {
      headers: HEADERS
    });

    if (!response.ok) {
      throw new Error(`Polling failed: ${await response.text()}`);
    }

    const data = await response.json();
    console.log(`[${fileName}] Task Status: ${data.status} (Progress: ${data.progress}%)`);

    if (data.status === "SUCCEEDED") {
      return data.model_urls.glb;
    } else if (data.status === "FAILED" || data.status === "EXPIRED") {
      throw new Error(`Task failed or expired: ${JSON.stringify(data.task_error)}`);
    }

    // Wait 10 seconds before polling again
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error("Task timeout exceeded.");
}

async function downloadGLB(url, fileName) {
  const dest = path.join(TARGET_DIR, fileName.replace('.png', '.glb'));
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Failed to download GLB for ${fileName}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
  console.log(`Successfully downloaded: ${dest}`);
}

async function processLobster(fileName) {
  const sourceFile = path.join(SOURCE_DIR, fileName);
  if (!fs.existsSync(sourceFile)) {
    console.warn(`Source file not found: ${fileName}. Skipping.`);
    return;
  }

  try {
    console.log(`Processing ${fileName}... converting to base64...`);
    const base64Uri = imageToBase64Uri(sourceFile);
    
    console.log(`Sending to Meshy API to start generation...`);
    const taskId = await startMeshyTask(base64Uri);
    console.log(`Task created with ID: ${taskId}`);

    console.log(`Polling for completion...`);
    const glbUrl = await pollMeshyTask(taskId, fileName);
    
    console.log(`Model generated! Downloading from ${glbUrl}...`);
    await downloadGLB(glbUrl, fileName);
    
  } catch (error) {
    console.error(`Error processing ${fileName}:`, error.message);
  }
}

async function main() {
  for (const lobster of LOBSTERS) {
    await processLobster(lobster);
  }
  console.log("All generation attempts completed.");
}

main().catch(err => console.error(err));
