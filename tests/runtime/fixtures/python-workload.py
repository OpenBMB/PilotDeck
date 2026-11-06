"""Offline synthetic data/document round trips and a local wheel for installation isolation."""
import json
import socket
import sys
import zipfile
from pathlib import Path

def no_network(*_args, **_kwargs):
    raise AssertionError("Native smoke test must not access the network")

socket.create_connection = no_network
socket.socket.connect = no_network
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import stats
import sympy
from openpyxl import Workbook, load_workbook
from docx import Document
from pptx import Presentation
from reportlab.pdfgen import canvas
from pypdf import PdfReader
import pymupdf

root = Path(sys.argv[1])
assert np.dot([1, 2], [3, 4]) == 11
assert pd.DataFrame({"value": [2, 3]}).value.sum() == 5
assert stats.norm.cdf(0) == 0.5
x = sympy.Symbol('x')
assert sympy.integrate(x, x) == x ** 2 / 2
plt.plot([0, 1, 2], [1, 3, 2])
plt.savefig(root / "synthetic.png")
plt.close()
assert (root / "synthetic.png").stat().st_size > 0
book = Workbook()
book.properties.creator = "PilotDeck Test"
book.active["A1"] = 42
book.save(root / "synthetic.xlsx")
assert load_workbook(root / "synthetic.xlsx").active["A1"].value == 42
doc = Document()
doc.core_properties.author = doc.core_properties.last_modified_by = "PilotDeck Test"
doc.add_paragraph("Synthetic text")
doc.save(root / "synthetic.docx")
assert Document(root / "synthetic.docx").paragraphs[0].text == "Synthetic text"
slides = Presentation()
slides.core_properties.author = slides.core_properties.last_modified_by = "PilotDeck Test"
slides.slides.add_slide(slides.slide_layouts[0]).shapes.title.text = "Synthetic title"
slides.save(root / "synthetic.pptx")
assert Presentation(root / "synthetic.pptx").slides[0].shapes.title.text == "Synthetic title"
pdf = canvas.Canvas(str(root / "synthetic.pdf"))
pdf.setAuthor("PilotDeck Test")
pdf.drawString(30, 30, "Synthetic PDF")
pdf.save()
assert "Synthetic PDF" in PdfReader(root / "synthetic.pdf").pages[0].extract_text()
with pymupdf.open(root / "synthetic.pdf") as document:
    assert document[0].get_pixmap().width > 0
with zipfile.ZipFile(root / "pilotdeck_fixture-1.0-py3-none-any.whl", "w") as wheel:
    wheel.writestr("pilotdeck_fixture/__init__.py", "VALUE = 42\n")
    wheel.writestr("pilotdeck_fixture-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: pilotdeck-fixture\nVersion: 1.0\n")
    wheel.writestr("pilotdeck_fixture-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: PilotDeck Test\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
    wheel.writestr("pilotdeck_fixture-1.0.dist-info/RECORD", "")
print(json.dumps({"executable": sys.executable, "version": sys.version.split()[0]}))
