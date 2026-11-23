"""Draws the Cleancord logo (extension icons + docs/media/logo.png). Run: python3 scripts/make-icons.py"""
import pathlib
from PIL import Image, ImageDraw

REPO = pathlib.Path(__file__).resolve().parent.parent
S = 2048  # drawn large, then scaled down for smooth edges


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def background():
    grad = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(grad)
    a, b = (16, 185, 129), (14, 165, 233)
    for i in range(2 * S):
        d.line([(i, 0), (0, i)], fill=lerp(a, b, i / (2 * S - 1)) + (255,), width=2)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)
    out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def broom():
    """An upright broom drawn as overlapping solid shapes, so nothing can look detached."""
    k = S / 1024
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    W = (255, 255, 255, 255)
    cx = 512
    # handle with a rounded top, running down into the binding
    d.rounded_rectangle([(cx - 34) * k, 110 * k, (cx + 34) * k, 600 * k], radius=34 * k, fill=W)
    # binding band (overlaps both handle and head)
    d.rounded_rectangle([(cx - 92) * k, 548 * k, (cx + 92) * k, 632 * k], radius=22 * k, fill=W)
    # head: flares out, bottom edge is a bristle fringe (part of the same polygon)
    top, bottom, notch = 610, 905, 850
    left_top, right_top, left_bot, right_bot = cx - 100, cx + 100, cx - 196, cx + 196
    pts = [(left_top, top), (right_top, top), (right_bot, bottom - 40)]
    teeth = 6
    span = right_bot - left_bot
    for i in range(teeth):
        x_right = right_bot - span * i / teeth
        x_mid = x_right - span / teeth / 2
        x_left = right_bot - span * (i + 1) / teeth
        pts += [(x_mid, bottom), (x_left, notch if i < teeth - 1 else bottom - 40)]
    pts += [(left_bot, bottom - 40)]
    d.polygon([(x * k, y * k) for x, y in pts], fill=W)
    return layer


def sparkle(d, cx, cy, r):
    k = S / 1024
    cx, cy, r = cx * k, cy * k, r * k
    w = r * 0.26
    d.polygon([(cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w), (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w)], fill=(255, 255, 255, 245))


def logo():
    img = background()
    b = broom().rotate(-35, resample=Image.BICUBIC, center=(S / 2, S / 2))
    img.alpha_composite(b, (int(-0.045 * S), int(-0.035 * S)))
    d = ImageDraw.Draw(img)
    sparkle(d, 790, 650, 96)
    sparkle(d, 690, 850, 52)
    return img


if __name__ == '__main__':
    big = logo()
    for s in (16, 32, 48, 128):
        big.resize((s, s), Image.LANCZOS).save(REPO / 'extension' / 'icons' / f'icon{s}.png', optimize=True)
    (REPO / 'docs' / 'media').mkdir(parents=True, exist_ok=True)
    big.resize((256, 256), Image.LANCZOS).save(REPO / 'docs' / 'media' / 'logo.png', optimize=True)
    print('icons written')
