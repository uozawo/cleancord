"""Procedural pixel-art images, avatars and server icons for the demo recordings. Nothing here is a real person or artwork."""
import io
import random
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont

FONT_PATHS = ['/usr/share/fonts/opentype/inter/Inter-Bold.otf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']


def font(size):
    for p in FONT_PATHS:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def png(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def pixel_canvas(w, h, top, bottom):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(top, bottom, y / max(1, h - 1)))
    return im, d


def forest_tileset():
    rnd = random.Random(1)
    im, d = pixel_canvas(96, 54, (124, 196, 255), (214, 238, 255))
    d.ellipse([74, 5, 84, 15], fill=(255, 236, 150))
    for x in range(0, 96, 2):
        h = 30 + int(4 * ((x * 7) % 5) / 5)
        d.rectangle([x, h, x + 1, 40], fill=(86, 140, 96))
    for i in range(14):
        x = rnd.randint(0, 92); base = rnd.randint(34, 40); hgt = rnd.randint(8, 14)
        for row in range(hgt):
            half = max(1, (row * 3) // hgt + 1)
            d.line([(x - half + 2, base - hgt + row), (x + half + 2, base - hgt + row)], fill=lerp((38, 112, 64), (24, 82, 48), row / hgt))
        d.rectangle([x + 2, base, x + 2, base + 2], fill=(92, 64, 40))
    d.rectangle([0, 41, 96, 54], fill=(52, 120, 180))
    for i in range(40):
        x = rnd.randint(0, 94); y = rnd.randint(42, 53)
        d.line([(x, y), (x + rnd.randint(1, 3), y)], fill=(150, 210, 245))
    d.rectangle([0, 40, 96, 41], fill=(110, 84, 56))
    return im.resize((960, 540), Image.NEAREST)


def autumn_leaves():
    rnd = random.Random(2)
    im, d = pixel_canvas(90, 60, (255, 196, 120), (214, 92, 54))
    for i in range(70):
        x = rnd.randint(0, 88); y = rnd.randint(0, 58)
        c = rnd.choice([(196, 60, 36), (240, 140, 40), (250, 196, 70), (150, 52, 30)])
        d.rectangle([x, y, x + 1, y + 1], fill=c)
        d.point((x + 2, y + 1), fill=c)
    d.rectangle([42, 20, 46, 60], fill=(96, 58, 38))
    d.ellipse([22, 2, 68, 32], fill=(214, 88, 40))
    d.ellipse([30, 6, 60, 26], fill=(240, 140, 52))
    return im.resize((900, 600), Image.NEAREST)


def city_night():
    rnd = random.Random(3)
    im, d = pixel_canvas(96, 54, (18, 22, 56), (62, 40, 96))
    for i in range(30):
        d.point((rnd.randint(0, 95), rnd.randint(0, 25)), fill=(230, 230, 255))
    d.ellipse([76, 4, 86, 14], fill=(250, 244, 210))
    x = 0
    while x < 96:
        w = rnd.randint(6, 12); h = rnd.randint(16, 40)
        shade = rnd.randint(26, 46)
        d.rectangle([x, 54 - h, x + w - 1, 54], fill=(shade, shade + 4, shade + 22))
        for wy in range(54 - h + 2, 52, 3):
            for wx in range(x + 1, x + w - 1, 2):
                if rnd.random() < 0.45:
                    d.point((wx, wy), fill=rnd.choice([(255, 214, 110), (255, 240, 170), (140, 220, 255)]))
        x += w + 1
    return im.resize((960, 540), Image.NEAREST)


def cat_sketch():
    im, d = pixel_canvas(32, 32, (255, 226, 236), (236, 210, 255))
    body = (90, 90, 104)
    d.polygon([(8, 10), (11, 3), (14, 10)], fill=body)
    d.polygon([(18, 10), (21, 3), (24, 10)], fill=body)
    d.ellipse([6, 8, 26, 26], fill=body)
    d.rectangle([11, 14, 12, 16], fill=(250, 220, 90)); d.rectangle([19, 14, 20, 16], fill=(250, 220, 90))
    d.point((16, 19), fill=(255, 150, 170))
    d.line([(14, 21), (16, 22), (18, 21)], fill=(40, 40, 48))
    return im.resize((640, 640), Image.NEAREST)


def level_one():
    rnd = random.Random(4)
    im, d = pixel_canvas(96, 54, (110, 200, 255), (190, 236, 255))
    for cx in (12, 52, 80):
        d.ellipse([cx, 6, cx + 12, 12], fill=(255, 255, 255))
    d.rectangle([0, 46, 96, 54], fill=(96, 176, 80)); d.rectangle([0, 48, 96, 54], fill=(132, 92, 60))
    for (x, y, w) in [(10, 36, 14), (34, 28, 12), (56, 20, 14), (78, 32, 12)]:
        d.rectangle([x, y, x + w, y + 2], fill=(150, 104, 66)); d.rectangle([x, y, x + w, y], fill=(96, 176, 80))
        for c in range(x + 2, x + w - 1, 4):
            d.ellipse([c, y - 5, c + 2, y - 3], fill=(255, 214, 60))
    d.rectangle([18, 40, 21, 45], fill=(240, 90, 90)); d.rectangle([18, 38, 21, 40], fill=(255, 214, 180))
    return im.resize((960, 540), Image.NEAREST)


def lighting_thumb():
    im = Image.new('RGB', (400, 400), (24, 26, 46))
    d = ImageDraw.Draw(im)
    for r in range(150, 0, -2):
        t = r / 150
        d.ellipse([200 - r - 20, 200 - r + 10, 200 + r - 20, 200 + r + 10], fill=lerp((255, 214, 140), (90, 60, 140), t))
    d.arc([30, 40, 330, 360], 280, 20, fill=(140, 220, 255), width=10)
    return im.resize((100, 100), Image.NEAREST).resize((400, 400), Image.NEAREST)


IMAGES = {
    'forest_tileset.png': forest_tileset, 'autumn_leaves.png': autumn_leaves, 'city_night.png': city_night,
    'cat_sketch.png': cat_sketch, 'level_one.png': level_one, 'lighting_thumb.png': lighting_thumb,
}

AVATARS = {
    '310000000000000001': ((16, 185, 129), 'A'), '310000000000000002': ((236, 72, 153), 'M'),
    '310000000000000003': ((245, 158, 11), 'J'), '310000000000000004': ((139, 92, 246), 'S'),
    '310000000000000005': ((239, 68, 68), 'R'), '310000000000000006': ((59, 130, 246), '⚙'),
}
ICONS = {
    '320000000000000001': ((16, 185, 129), (14, 165, 233), 'CP'), '320000000000000002': ((49, 46, 129), (124, 58, 237), '🦉'),
    '320000000000000004': ((220, 38, 38), (249, 115, 22), 'RR'),
}


def avatar(uid):
    color, letter = AVATARS.get(uid, ((120, 120, 130), '?'))
    im = Image.new('RGB', (128, 128), color)
    d = ImageDraw.Draw(im)
    for y in range(128):
        d.line([(0, y), (128, y)], fill=lerp(color, tuple(max(0, c - 50) for c in color), y / 127))
    f = font(64)
    if letter == '⚙':
        d.ellipse([34, 34, 94, 94], outline=(255, 255, 255), width=12)
        d.ellipse([56, 56, 72, 72], fill=(255, 255, 255))
    else:
        d.text((64, 66), letter, font=f, fill=(255, 255, 255), anchor='mm')
    return im


def guild_icon(gid):
    a, b, label = ICONS.get(gid, ((90, 90, 100), (60, 60, 70), '?'))
    im = Image.new('RGB', (128, 128))
    d = ImageDraw.Draw(im)
    for i in range(256):
        d.line([(i, 0), (0, i)], fill=lerp(a, b, i / 255), width=2)
    if label == '🦉':
        d.ellipse([30, 34, 98, 104], fill=(250, 240, 220))
        d.ellipse([42, 50, 60, 68], fill=(30, 30, 40)); d.ellipse([68, 50, 86, 68], fill=(30, 30, 40))
        d.polygon([(58, 74), (70, 74), (64, 84)], fill=(245, 158, 11))
    else:
        d.text((64, 66), label, font=font(48), fill=(255, 255, 255), anchor='mm')
    return im


@lru_cache(maxsize=None)
def cdn_bytes(path):
    """Returns PNG bytes for a Discord CDN path used by the demo."""
    parts = [p for p in path.split('?')[0].split('/') if p]
    name = parts[-1] if parts else ''
    if 'avatars' in parts and len(parts) >= 3 and parts[0] == 'avatars':
        return png(avatar(parts[1]))
    if parts[:2] == ['embed', 'avatars']:
        return png(avatar('0'))
    if parts and parts[0] == 'icons':
        return png(guild_icon(parts[1]))
    if name in IMAGES:
        return png(IMAGES[name]())
    return png(Image.new('RGBA', (2, 2), (0, 0, 0, 0)))
