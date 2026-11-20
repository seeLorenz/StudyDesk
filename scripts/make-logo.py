"""Makes StudyDesk's logo files from the full SD planet artwork.

Usage: python3 -I scripts/make-logo.py <sd-logo.png>

The artwork is a glowing mark on black. Only the planet and the letters are
kept: the planet stays a solid dark disc (so the mark reads on light and dark
backgrounds alike), and the black space around it becomes transparent, with
brightness turned into opacity so the glow of the letters fades out softly.
The thin outer rings are dropped; they turn into noise at icon sizes.
"""
import sys
import numpy as np
from PIL import Image

src = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(np.float32) / 255
h, w, _ = src.shape
# Planet centre and radius as shares of the artwork's width.
cx, cy, r = 0.502 * w, 0.492 * h, 0.292 * w
keep = r * 1.13  # how far the letters' glow may reach outside the planet
yy, xx = np.mgrid[0:h, 0:w]
d = np.hypot(xx - cx, yy - cy)
disc = np.clip((r - d) / 3 + 0.5, 0, 1)
peak = src.max(axis=2)
glow = np.clip((peak - 0.10) / 0.45, 0, 1) * np.clip((keep - d) / (keep - r), 0, 1)
alpha = np.maximum(disc, glow)
# Outside the disc the colour is un-darkened, so the glow keeps its tint once the black is gone.
rgb = np.where(disc[..., None] >= 1, src, src / np.maximum(alpha[..., None], 1e-3))
rgba = np.dstack([np.clip(rgb, 0, 1), alpha])
img = Image.fromarray((rgba * 255).round().astype(np.uint8), "RGBA")
img = img.crop((int(cx - keep), int(cy - keep), int(cx + keep), int(cy + keep)))

for size, name in [(128, "logo.png"), (64, "favicon.png")]:
    small = img.resize((size, size), Image.LANCZOS)
    small.save(f"src/assets/{name}", optimize=True)
print("wrote src/assets/logo.png and src/assets/favicon.png")
