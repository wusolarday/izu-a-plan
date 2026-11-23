# 產生 A計畫 圖示：白底、中間一串半透明交疊的金色圓圈（往右上微升）
# 用法：python3 scripts/make_icon.py icons   （改 CIRCLES 的位置、顏色、透明度就能換圖示）
# 純 Python（不用影像套件）：每個像素算到圓邊的距離做反鋸齒，再用 alpha 疊色
import sys, zlib, struct, math

def hexrgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

# 圓（中心 x, y、半徑都是相對大小 0～1），由左到右：淺金 → 琥珀
CIRCLES = [
    (0.285, 0.565, 0.165, '#f6d266', 0.86),
    (0.430, 0.522, 0.165, '#f1bf3c', 0.80),
    (0.575, 0.478, 0.165, '#e6a52a', 0.78),
    (0.720, 0.435, 0.165, '#d38a1c', 0.78),
]

def render(size):
    rows = []
    circles = [(cx * size, cy * size, r * size, hexrgb(c), a) for cx, cy, r, c, a in CIRCLES]
    for y in range(size):
        row = bytearray(b'\x00')  # filter type 0
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            R, G, B = 255.0, 255.0, 255.0
            for cx, cy, r, (cr, cg, cb), a in circles:
                d = math.hypot(px - cx, py - cy)
                cov = r - d + 0.5
                if cov <= 0: continue
                k = a * (1.0 if cov >= 1 else cov)
                R = cr * k + R * (1 - k); G = cg * k + G * (1 - k); B = cb * k + B * (1 - k)
            row += bytes((round(R), round(G), round(B)))
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

out = sys.argv[1]
for name, size in (('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180)):
    open(f'{out}/{name}', 'wb').write(render(size))
    print(name, size)
