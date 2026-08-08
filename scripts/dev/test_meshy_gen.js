// One-off local dev script — not invoked by any npm script or CI workflow.
// ITEMS below point at ephemeral source images from a single past dev
// session and will not exist on another machine; update the paths to your
// own local source PNGs before running this manually.
import fs from 'fs';
import path from 'path';

// Fallback to test key
const API_KEY = process.env.MESHY_API_KEY || "msy_dummy_api_key_for_test_mode_12345678";
const HEADERS = {
  "Authorization": `Bearer ${API_KEY}`,
  "Content-Type": "application/json"
};

const ITEMS = [
  { path: "/Users/scottieryan/.gemini/antigravity/brain/ff6f2185-9f48-4367-b1db-e8eb93ca3091/clipboard_accessory_1777962363110.png", name: "Clipboard" },
  { path: "/Users/scottieryan/.gemini/antigravity/brain/ff6f2185-9f48-4367-b1db-e8eb93ca3091/executive_plant_decor_1777962382712.png", name: "ExecutivePlant" }
];

const TARGET_DIR = "./public/models/assets";

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
      topology: "quad",
      target_polycount: 10000 
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
  while (attempt < 120) {
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

    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error("Task timeout exceeded.");
}

async function downloadGLB(url, fileName) {
  const dest = path.join(TARGET_DIR, `${fileName}.glb`);
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Failed to download GLB for ${fileName}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
  
  // also copy the original PNG for UI
  const sourceItem = ITEMS.find(i => i.name === fileName);
  if (sourceItem) {
     fs.copyFileSync(sourceItem.path, path.join(TARGET_DIR, `${fileName}.png`));
  }
  
  console.log(`Successfully downloaded: ${dest}`);
}

async function processItem(item) {
  try {
    console.log(`Processing ${item.name}...`);
    const base64Uri = imageToBase64Uri(item.path);
    const taskId = await startMeshyTask(base64Uri);
    console.log(`Task created with ID: ${taskId}`);
    const glbUrl = await pollMeshyTask(taskId, item.name);
    await downloadGLB(glbUrl, item.name);
  } catch (error) {
    console.error(`Error processing ${item.name}:`, error.message);
  }
}

async function main() {
  for (const item of ITEMS) {
    await processItem(item);
  }
  console.log("All generation attempts completed.");
}

main().catch(err => console.error(err));
