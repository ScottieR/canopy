import os
from PIL import Image

input_dir = "/Users/scottieryan/Documents/Claude/Projects/Agent Management/Lobster Styling/accessories"
output_dir = os.path.join(input_dir, "sliced")

os.makedirs(output_dir, exist_ok=True)

rows, cols = 5, 5
total_sliced = 0

for filename in os.listdir(input_dir):
    if filename.endswith(".png") and "Set" in filename:
        filepath = os.path.join(input_dir, filename)
        try:
            img = Image.open(filepath)
            width, height = img.size
            
            piece_width = width // cols
            piece_height = height // rows
            
            base_name = os.path.splitext(filename)[0].replace(" ", "_").lower()
            
            count = 1
            for i in range(rows):
                for j in range(cols):
                    left = j * piece_width
                    upper = i * piece_height
                    right = left + piece_width
                    lower = upper + piece_height
                    
                    piece = img.crop((left, upper, right, lower))
                    
                    # We can use a basic bounding box check to see if the chunk is completely blank/white
                    # But it's safer to just export them all so you don't lose faint objects
                    piece_name = f"{base_name}_item_{count:02d}.png"
                    piece.save(os.path.join(output_dir, piece_name))
                    count += 1
                    total_sliced += 1
            print(f"Sliced: {filename}")
        except Exception as e:
            print(f"Failed to process {filename}: {e}")

print(f"\nSuccessfully extracted {total_sliced} individual accessories into the 'sliced' folder!")
