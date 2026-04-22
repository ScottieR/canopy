import os
from PIL import Image

def is_mostly_blank(img_path):
    try:
        img = Image.open(img_path).convert("L") # Convert to grayscale
        extrema = img.getextrema()
        
        # If the minimum pixel value is 250 (almost pure white) and the max is 255
        # it means the entire image is basically a blank white square.
        if type(extrema) == tuple and len(extrema) == 2:
            min_val, max_val = extrema
            if min_val >= 240:
                return True
        return False
    except Exception as e:
        print(f"Error reading {img_path}: {e}")
        return False

target_dir = "/Users/scottieryan/Documents/Claude/Projects/Agent Management/Lobster Styling/accessories/sliced"
deleted_count = 0

if os.path.exists(target_dir):
    for filename in os.listdir(target_dir):
        if filename.endswith(".png"):
            filepath = os.path.join(target_dir, filename)
            if is_mostly_blank(filepath):
                os.remove(filepath)
                deleted_count += 1
                
print(f"Cleanup complete! Automatically deleted {deleted_count} perfectly blank tiles from the folder.")
