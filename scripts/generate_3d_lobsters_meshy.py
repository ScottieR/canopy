import os
import json
import time
import base64
import urllib.request
import urllib.error

API_KEY = os.environ.get("MESHY_API_KEY", "msy_dummy_api_key_for_test_mode_12345678")
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

LOBSTERS = ["FlatIvyBase.png"]
SOURCE_DIR = os.path.join(os.path.dirname(__file__), "../public/agents")
TARGET_DIR = os.path.join(os.path.dirname(__file__), "../public/models/lobsters")

if not os.path.exists(TARGET_DIR):
    os.makedirs(TARGET_DIR)

def image_to_base64_uri(file_path):
    with open(file_path, "rb") as f:
        data = f.read()
    b64 = base64.b64encode(data).decode('utf-8')
    return f"data:image/png;base64,{b64}"

def start_meshy_task(image_url):
    req = urllib.request.Request(
        "https://api.meshy.ai/openapi/v1/image-to-3d",
        headers=HEADERS,
        data=json.dumps({
            "image_url": image_url,
            "enable_pbr": True,
            "topology": "quad",
            "target_polycount": 30000
        }).encode('utf-8')
    )
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read())
            return result.get("result")
    except urllib.error.HTTPError as e:
        print(f"HTTPError: {e.code} - {e.read().decode('utf-8')}")
        raise

def poll_meshy_task(task_id, file_name):
    url = f"https://api.meshy.ai/openapi/v1/image-to-3d/{task_id}"
    req = urllib.request.Request(url, headers=HEADERS)
    attempt = 0
    while attempt < 120:
        attempt += 1
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read())
        print(f"[{file_name}] Status: {data.get('status')} (Progress: {data.get('progress')}%)")
        if data.get("status") == "SUCCEEDED":
            return data["model_urls"]["glb"]
        elif data.get("status") in ("FAILED", "EXPIRED"):
            raise Exception(f"Task failed: {data.get('task_error')}")
        time.sleep(10)
    raise Exception("Polling timeout")

def download_glb(url, file_name):
    dest = os.path.join(TARGET_DIR, file_name.replace(".png", ".glb"))
    urllib.request.urlretrieve(url, dest)
    print(f"Downloaded to {dest}")

def process(lobster):
    source = os.path.join(SOURCE_DIR, lobster)
    if not os.path.exists(source):
        print(f"Skipping {lobster}, file not found")
        return
    print(f"Processing {lobster}...")
    try:
        b64 = image_to_base64_uri(source)
        task_id = start_meshy_task(b64)
        print(f"Started task {task_id}")
        glb_url = poll_meshy_task(task_id, lobster)
        download_glb(glb_url, lobster)
    except Exception as e:
        print(f"Error processing {lobster}: {e}")

import concurrent.futures

if __name__ == "__main__":
    print(f"Starting Meshy generation for {len(LOBSTERS)} models...")
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(process, item): item for item in LOBSTERS}
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                future.result()
                print(f"[{item}] Successfully completed.")
            except Exception as exc:
                print(f"[{item}] Generated an exception: {exc}")
    print("All generation attempts completed.")
