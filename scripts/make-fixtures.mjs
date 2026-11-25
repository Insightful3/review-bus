// Regenerates the binary test fixtures from text. Fictional companies only; no real data.
// Run: node scripts/make-fixtures.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";

const dir = new URL("../test/fixtures/", import.meta.url);

// 1. Contract (DOCX). Deliberate problems for reviewers to find:
//    price in clause 3 (EUR 24,000) differs from Annex 1 (EUR 22,500); liability is unlimited;
//    no governing law; personal data processed with no DPA.
const h = (text, level = HeadingLevel.HEADING_1) => new Paragraph({ text, heading: level });
const p = (text) => new Paragraph({ children: [new TextRun(text)] });
const cell = (text, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
const contract = new Document({
  sections: [
    {
      children: [
        new Paragraph({ text: "Services Agreement", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
        p("Fictional test document. The companies and people in it do not exist."),
        h("1. Parties"),
        p("Northwind Labs d.o.o., Testna ulica 1, 1000 Ljubljana, Slovenia, registration number 0000001 (the Supplier), and"),
        p("Bluefin Logistics GmbH, Beispielstrasse 2, 10115 Berlin, Germany, registration number HRB 000002 (the Client)."),
        h("2. Scope"),
        p("The Supplier builds and launches a customer support assistant for the Client as described in Annex 1. The assistant answers questions from the Client's customers using the Client's help center and its customer records."),
        h("3. Price and payment"),
        p("The total fixed price is EUR 24,000 excluding VAT. The Supplier invoices 50% on signature and 50% on go-live. Invoices are due within 15 days."),
        h("4. Term and termination"),
        p("This Agreement starts on signature and ends on go-live plus 60 days. Either party may terminate for material breach with 30 days written notice."),
        h("5. Liability"),
        p("The Supplier is liable for all damages arising from this Agreement."),
        h("6. Confidentiality"),
        p("Each party keeps the other party's confidential information secret during the term of this Agreement."),
        h("Annex 1: Deliverables and price"),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [cell("Item", true), cell("Amount", true)] }),
            new TableRow({ children: [cell("Setup and integration"), cell("EUR 14,500")] }),
            new TableRow({ children: [cell("Training and testing"), cell("EUR 8,000")] }),
            new TableRow({ children: [cell("Total"), cell("EUR 22,500")] }),
          ],
        }),
      ],
    },
  ],
});
writeFileSync(new URL("contract-northwind-bluefin.docx", dir), await Packer.toBuffer(contract));

// 2. Proposal (PDF), two pages, from the Markdown fixture.
const md = readFileSync(new URL("proposal-bluefin.md", dir), "utf8").replace(/^#+ /gm, "").replace(/\|/g, " ");
const lines = md.split("\n");
const pdf = await PDFDocument.create();
pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
const font = await pdf.embedFont(StandardFonts.Helvetica);
const half = Math.ceil(lines.length / 2);
for (const chunk of [lines.slice(0, half), lines.slice(half)]) {
  const page = pdf.addPage([595, 842]);
  let y = 800;
  for (const line of chunk) {
    // Simple word wrap at about 90 characters.
    const words = line.split(" ");
    let current = "";
    for (const w of words) {
      if ((current + " " + w).length > 90) {
        page.drawText(current, { x: 40, y, size: 10, font });
        y -= 14;
        current = w;
      } else current = current ? `${current} ${w}` : w;
    }
    page.drawText(current, { x: 40, y, size: 10, font });
    y -= 14;
  }
}
writeFileSync(new URL("proposal-bluefin.pdf", dir), await pdf.save());
console.log("fixtures written");
