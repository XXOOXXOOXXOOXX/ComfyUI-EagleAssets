import json
import sys
import tempfile
from PIL import Image, ImageDraw
from fixture import Fixture

with tempfile.TemporaryDirectory(prefix="eagle-alpha-test-") as root:
    fixture = Fixture(root)
    path = fixture.library / "images/asset0.info/1.png"
    image = Image.new("RGBA", (160, 120), (255, 0, 255, 0))
    draw = ImageDraw.Draw(image); draw.ellipse((45, 25, 115, 95), fill=(240, 90, 20, 255))
    image.save(path)
    fixture.items[0].update(width=160, height=120)
    print(json.dumps({"host": fixture.host}), flush=True)
    try:
        sys.stdin.readline()
    finally:
        fixture.close()
