"""Export a .docx to plain text in document order, for reviewers.

`pandoc -t plain` attaches caption-styled paragraphs to the following table, which makes table
captions look shifted by one. This export walks the body in order and prints each table as
' | '-separated rows, so every caption stays directly after its own table.

Usage:
    python3 docs/tools/export_paper_text.py paper.docx output.txt
"""
import sys
import zipfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def q(tag):
    return f"{{{W}}}{tag}"


def text_of(element):
    return "".join(node.text or "" for node in element.iter(q("t"))).strip()


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    source, target = sys.argv[1:]
    body = etree.fromstring(zipfile.ZipFile(source).read("word/document.xml")).find(q("body"))
    lines = []
    for element in body:
        if element.tag == q("p"):
            text = text_of(element)
            if text:
                lines.extend([text, ""])
        elif element.tag == q("tbl"):
            for row in element.iter(q("tr")):
                lines.append(" | ".join(text_of(cell) for cell in row.iter(q("tc"))))
            lines.append("")
    with open(target, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    print(f"Wrote {target} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
