# Locate the suggestion pills block in an empty-state screenshot.
# Dark theme: background ~very dark; pill borders / text are light.
# Strategy: for each row, count "bright" pixels (luma > 90); cluster rows
# with counts above noise; report horizontal extent of each cluster.
import sys
from PIL import Image

path = sys.argv[1]
img = Image.open(path).convert("RGB")
w, h = img.size
px = img.load()

def luma(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]

# row brightness profile
rows = []
for y in range(h):
    c = 0
    for x in range(0, w, 2):
        if luma(px[x, y]) > 90:
            c += 1
    rows.append(c)

# cluster rows where count >= 3 (text lines / pill strokes)
clusters = []
y = 0
while y < h:
    if rows[y] >= 3:
        y0 = y
        while y < h and rows[y] >= 3:
            y += 1
        clusters.append((y0, y - 1))
    else:
        y += 1

print(f"image {w}x{h}")
for (y0, y1) in clusters:
    # horizontal extent of bright pixels within the cluster
    xmin, xmax = w, 0
    for y in range(y0, y1 + 1, 2):
        for x in range(0, w, 2):
            if luma(px[x, y]) > 90:
                if x < xmin: xmin = x
                if x > xmax: xmax = x
    print(f"cluster rows {y0}-{y1}  x=[{xmin},{xmax}]  height={y1-y0+1}  center_x={(xmin+xmax)//2}")
