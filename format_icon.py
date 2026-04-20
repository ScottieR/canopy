import sys
from PIL import Image, ImageDraw, ImageChops

def remove_white_bg(img, bg_color=(250, 249, 246)):
    """Replaces pure white with transparency, so we can isolate the lobster."""
    img = img.convert("RGBA")
    data = img.getdata()
    newData = []
    
    for item in data:
        # Check if the pixel is functionally white
        if item[0] > 240 and item[1] > 240 and item[2] > 240:
            newData.append((255, 255, 255, 0)) # Fully transparent
        else:
            newData.append(item)
    img.putdata(newData)
    return img

def round_corners(im, rad):
    """Applies a smooth corner radius to the image alpha channel."""
    circle = Image.new('L', (rad * 2, rad * 2), 0)
    draw = ImageDraw.Draw(circle)
    draw.ellipse((0, 0, rad * 2, rad * 2), fill=255)
    
    alpha = Image.new('L', im.size, 255)
    w, h = im.size
    alpha.paste(circle.crop((0, 0, rad, rad)), (0, 0))
    alpha.paste(circle.crop((rad, 0, rad * 2, rad)), (w - rad, 0))
    alpha.paste(circle.crop((0, rad, rad, rad * 2)), (0, h - rad))
    alpha.paste(circle.crop((rad, rad, rad * 2, rad * 2)), (w - rad, h - rad))
    
    # We apply this alpha curve to the existing image
    im.putalpha(alpha)
    return im

def main():
    try:
        # Load the original icon (stark white background)
        # We'll use the root one as the source
        source_path = 'app-icon.png'
        img = Image.open(source_path).convert("RGBA")
        
        # 1. Strip the white background to isolate the lobster
        isolated_lobster = remove_white_bg(img)
        
        # 2. Get the actual pixel bounding box of the lobster
        bbox = isolated_lobster.getbbox()
        if not bbox:
            print("Could not isolate non-white bounds.")
            sys.exit(1)
            
        cropped_lobster = isolated_lobster.crop(bbox)
        
        # 3. Create our new 1024x1024 canvas with the off-white color #FAF9F6
        canvas_size = 1024
        final_canvas = Image.new("RGBA", (canvas_size, canvas_size), (250, 249, 246, 255))
        
        # 4. Scale the lobster to cover roughly 70% of the canvas to give it perfect premium padding
        target_lobster_size = int(canvas_size * 0.70)
        
        # Calculate aspect ratio of cropped lobster
        width, height = cropped_lobster.size
        aspect = width / float(height)
        
        if aspect > 1:
            new_w = target_lobster_size
            new_h = int(new_w / aspect)
        else:
            new_h = target_lobster_size
            new_w = int(new_h * aspect)
            
        # Use high quality Lanczos resampling for premium look
        resized_lobster = cropped_lobster.resize((new_w, new_h), Image.Resampling.LANCZOS)
        
        # 5. Paste the centered lobster onto the off-white canvas
        paste_x = (canvas_size - new_w) // 2
        paste_y = (canvas_size - new_h) // 2
        final_canvas.paste(resized_lobster, (paste_x, paste_y), mask=resized_lobster)
        
        # 6. Apply macOS/iOS style continuous squircle curve (approx 22.5% of total width)
        corner_radius = int(canvas_size * 0.225)
        rounded_canvas = round_corners(final_canvas, corner_radius)
        
        # Save directly to both the root and public directory
        rounded_canvas.save('app-icon.png', 'PNG')
        rounded_canvas.save('public/app-icon.png', 'PNG')
        
        print("Successfully formatted app-icon.png with padded bounds, off-white background, and rounded corners!")

    except Exception as e:
        print(f"Error formulating image: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
