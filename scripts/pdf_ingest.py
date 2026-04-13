#!/usr/bin/env python3
"""
PDF Ingestion Script
Extracts text from PDF files and sends them to your RAG ingestion webhook.

This fills the missing step: your /knowledge folder has PDFs but
the n8n webhook only accepts raw text. This script bridges that gap.

Setup:
  1. Copy ../.env.example to ../.env and fill in WEBHOOK_URL
  2. pip install pdfplumber requests python-dotenv
  3. python pdf_ingest.py                     (ingests all PDFs in ../knowledge)
  4. python pdf_ingest.py path/to/file.pdf    (ingests a specific file)
"""

import os
import sys
import time
import requests
import pdfplumber
from pathlib import Path
from dotenv import load_dotenv

# Load .env from the project root (one level up from scripts/)
load_dotenv(Path(__file__).parent.parent / ".env")

# ─── CONFIG ─────────────────────────────────────────────────────
WEBHOOK_URL   = os.environ.get("WEBHOOK_URL", "")
KNOWLEDGE_DIR = Path(__file__).parent.parent / "knowledge"
# ────────────────────────────────────────────────────────────────

def validate_config():
    if not WEBHOOK_URL:
        print("\n❌  WEBHOOK_URL is not set in your .env file.")
        print("    Add this line to your .env:")
        print("    WEBHOOK_URL=https://your-n8n-instance/webhook/rag-ingest")
        sys.exit(1)

def extract_text_from_pdf(pdf_path: Path) -> str:
    """Extract all text from a PDF file, page by page."""
    full_text = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            total_pages = len(pdf.pages)
            print(f"  📄 {total_pages} pages found")
            for i, page in enumerate(pdf.pages, 1):
                text = page.extract_text()
                if text and text.strip():
                    full_text.append(text.strip())
                print(f"  ✔  Page {i}/{total_pages} extracted", end="\r")
        print()
    except Exception as e:
        print(f"\n  ❌  Failed to read PDF: {e}")
        return ""

    return "\n\n".join(full_text)

def send_to_webhook(text: str, source: str) -> bool:
    """POST extracted text to the n8n ingestion webhook."""
    try:
        response = requests.post(
            WEBHOOK_URL,
            json={"text": text, "source": source},
            timeout=60
        )
        if response.status_code == 200:
            data = response.json()
            chunks = data.get("chunks_stored", "unknown")
            print(f"  ✅  Ingested! Chunks stored: {chunks}")
            return True
        else:
            print(f"  ❌  Webhook returned {response.status_code}: {response.text[:200]}")
            return False
    except requests.exceptions.ConnectionError:
        print(f"  ❌  Could not connect to webhook. Is n8n running?")
        print(f"      URL: {WEBHOOK_URL}")
        return False
    except requests.exceptions.Timeout:
        print(f"  ❌  Request timed out. The document may be too large.")
        return False
    except Exception as e:
        print(f"  ❌  Error: {e}")
        return False

def ingest_pdf(pdf_path: Path) -> bool:
    """Full pipeline: extract text from PDF → send to webhook."""
    print(f"\n📂 Processing: {pdf_path.name}")

    text = extract_text_from_pdf(pdf_path)

    if not text.strip():
        print("  ⚠️  No text extracted. PDF may be scanned/image-based.")
        print("      Consider using OCR (e.g., pytesseract) for scanned PDFs.")
        return False

    word_count = len(text.split())
    print(f"  📝 Extracted {word_count} words")

    source = pdf_path.stem  # filename without extension
    return send_to_webhook(text, source)

def main():
    validate_config()

    # If a specific file is passed as argument, ingest just that
    if len(sys.argv) > 1:
        pdf_files = [Path(arg) for arg in sys.argv[1:]]
        for f in pdf_files:
            if not f.exists():
                print(f"❌  File not found: {f}")
            elif f.suffix.lower() != ".pdf":
                print(f"⚠️  Skipping non-PDF file: {f}")
            else:
                ingest_pdf(f)
        return

    # Otherwise, ingest all PDFs in the knowledge folder
    if not KNOWLEDGE_DIR.exists():
        print(f"❌  Knowledge folder not found: {KNOWLEDGE_DIR}")
        sys.exit(1)

    pdf_files = sorted(KNOWLEDGE_DIR.glob("*.pdf"))

    if not pdf_files:
        print(f"⚠️  No PDF files found in {KNOWLEDGE_DIR}")
        print("    Drop your PDF files there and re-run this script.")
        sys.exit(0)

    print(f"\n{'='*60}")
    print(f"📚  PDF INGESTION — {len(pdf_files)} file(s) found")
    print(f"{'='*60}")
    print(f"Webhook: {WEBHOOK_URL}")

    success_count = 0
    for pdf_path in pdf_files:
        if ingest_pdf(pdf_path):
            success_count += 1
        time.sleep(1)  # small delay between files to avoid rate limits

    print(f"\n{'='*60}")
    print(f"✅  Done! {success_count}/{len(pdf_files)} PDFs ingested successfully.")
    print(f"{'='*60}\n")

if __name__ == "__main__":
    main()
