import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
FONT = sys.argv[1]; OUT = sys.argv[2]
K = 4; N = 512 * K
def P(v): return int(v * K)
img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
grad = Image.new('RGBA', (N, N)); gd = ImageDraw.Draw(grad)
top, bot = (30, 42, 112), (22, 148, 212)
for y in range(N):
    t = y / (N - 1)
    gd.line([(0, y), (N, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
mask = Image.new('L', (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=P(104), fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
W = (255, 255, 255, 255)
# filled handset
f = ImageFont.truetype(FONT, P(190))
f.set_variation_by_axes([1, 0, 48, 500])
bb = d.textbbox((0, 0), chr(0xE0B0), font=f)
gh = bb[3] - bb[1]
hm = Image.new('L', (N, N), 0)
ImageDraw.Draw(hm).text((P(36) - bb[0], P(256) - gh // 2 - bb[1]), chr(0xE0B0), font=f, fill=255)
hm = hm.point(lambda v: 255 if v > 90 else 0).filter(ImageFilter.MaxFilter(13)).filter(ImageFilter.MinFilter(13)).filter(ImageFilter.GaussianBlur(1.2))
img.paste(Image.new('RGBA', (N, N), W), (0, 0), hm)
# route: trunk then smooth S-curves to three destinations
lw = P(20)
def stroke(pts):
    for a, b in zip(pts, pts[1:]): d.line([a, b], fill=W, width=lw)
    for (x, y) in pts:
        r = lw // 2; d.ellipse([x - r, y - r, x + r, y + r], fill=W)
def bez(p0, p1, p2, p3, n=60):
    out = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        out.append((u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
                    u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]))
    return out
sx, sy, mx = P(230), P(256), P(290)
stroke([(sx, sy), (mx, sy)])
ends = [(P(440), P(146)), (P(440), P(256)), (P(440), P(366))]
for ex, ey in ends:
    cx = P(380)
    stroke(bez((mx, sy), (mx + P(55), sy), (cx - P(45), ey), (cx, ey)) + [(ex, ey)])
for i, (ex, ey) in enumerate(ends):
    r = P(30); d.ellipse([ex - r, ey - r, ex + r, ey + r], fill=W)
# the path a simulated call takes: accent centre on the top destination
ex, ey = ends[0]; r = P(14)
d.ellipse([ex - r, ey - r, ex + r, ey + r], fill=(22, 148, 212, 255))
img.resize((512, 512), Image.LANCZOS).save(OUT)
print('ok')
