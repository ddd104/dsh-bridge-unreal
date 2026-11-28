"""Regenerate repository-owned PDF fixtures; needs reportlab, pypdf and Pillow.

These synthetic documents contain no project/customer material. Runtime PDF
extraction has no Python, Poppler, canvas or OCR dependency.
"""
from io import BytesIO
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter
from pypdf.constants import PageLabelStyle
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
out = root / "unreal/DSHUnrealBridge/Tools/test/fixtures/pdf"
out.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
data = BytesIO()
doc = canvas.Canvas(data, pagesize=(612, 792), invariant=1)
doc.setTitle("PDF page citation fixture")
doc.setFont("Helvetica", 18)
doc.drawString(48, 740, "PDF citation fixture - physical page 1")
doc.setFont("STSong-Light", 14)
doc.drawString(48, 700, "车辆休眠唤醒流程：重新绑定显示窗口。")
doc.setFont("Helvetica", 12)
doc.drawString(48, 660, "FirstPageMarker UDisplayLifecycle")
doc.showPage()
doc.showPage()  # Physical page 2 is genuinely blank.
scan = Image.new("RGB", (900, 240), "white")
draw = ImageDraw.Draw(scan)
draw.text((25, 50), "ScannedOnlyMarker - image text needs OCR", fill="black", font_size=30)
doc.drawImage(ImageReader(scan), 48, 540, width=516, height=138)
doc.showPage()
doc.setFont("STSong-Light", 14)
doc.drawString(48, 740, "第四页：电源恢复与页码引用。")
doc.setFont("Helvetica", 12)
doc.drawString(48, 712, "LaterPageMarker physical page 4, printed label 2")
doc.setFont("Helvetica", 8)
for i in range(50):
    doc.drawString(48, 684 - i * 12, f"Line{i:02d} LongPageMarker " + "bounded page content " * 5)
doc.showPage()
doc.setPageRotation(90)
doc.setFont("Helvetica", 14)
doc.drawString(48, 520, "RotatedPageMarker - physical page 5")
doc.save()

reader = PdfReader(BytesIO(data.getvalue()))
writer = PdfWriter()
writer.append(reader)
writer.set_page_label(0, 1, style=PageLabelStyle.LOWERCASE_ROMAN)
writer.set_page_label(2, 4, style=PageLabelStyle.DECIMAL)
writer.write(out / "pages.pdf")

scan_writer = PdfWriter()
scan_writer.add_page(reader.pages[2])
scan_writer.write(out / "scan.pdf")
locked = PdfWriter()
locked.add_page(reader.pages[0])
locked.encrypt("fixture-password", algorithm="RC4-128")
locked.write(out / "password.pdf")
(out / "damaged.pdf").write_bytes(b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 999 0 R >>\nendobj\n%%EOF")
print(out)
