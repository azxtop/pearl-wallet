"""Generate legacy Android launcher PNGs from the Pearl monogram geometry."""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def draw_icon(size: int, round_icon: bool = False, transparent: bool = False) -> Image.Image:
    scale = 8
    canvas_size = 128 * scale
    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0) if transparent or round_icon else "white")
    draw = ImageDraw.Draw(image)

    def box(x0: int, y0: int, x1: int, y1: int) -> tuple[int, int, int, int]:
        return x0 * scale, y0 * scale, x1 * scale, y1 * scale

    if round_icon:
        draw.ellipse(box(0, 0, 128, 128), fill="white")

    mark = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(mark)
    draw.ellipse(box(20, 31, 66, 77), fill="black")
    draw.rectangle(box(48, 30, 67, 78), fill=(0, 0, 0, 0))
    draw.ellipse(box(58, 31, 107, 77), fill="black")
    draw.rectangle(box(58, 31, 72, 97), fill="black")
    draw.ellipse(box(73, 37, 95, 71), fill=(0, 0, 0, 0))
    draw.rectangle(box(51, 96, 88, 100), fill="black")
    mark_size = round(canvas_size * 0.72)
    mark = mark.resize((mark_size, mark_size), Image.Resampling.LANCZOS)
    offset = (canvas_size - mark_size) // 2
    image.alpha_composite(mark, (offset, offset))
    return image.resize((size, size), Image.Resampling.LANCZOS)


for density, size in DENSITIES.items():
    folder = RES / f"mipmap-{density}"
    draw_icon(size).save(folder / "ic_launcher.png")
    draw_icon(size, round_icon=True).save(folder / "ic_launcher_round.png")
    draw_icon(size, transparent=True).save(folder / "ic_launcher_foreground.png")
