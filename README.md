# Personal RAG AI System
### Built with n8n + Supabase + OpenAI

> Ask your AI anything — it answers from YOUR documents. No hallucinations.

---

## Project Structure

```
rag-system/
│
├── knowledge/                        ← Drop your PDFs here
│   ├── Keerthivanan CV.pdf
│   └── Keerthivanan sridhar - Resume.pdf
│
├── n8n-workflows/                    ← Import these into n8n
│   ├── STEP2_ingestion_workflow.json    (feeds docs into Supabase)
│   └── STEP3_chat_workflow.json         (AI chat agent)
│
├── database/                         ← Run this in Supabase SQL Editor
│   └── STEP1_supabase_setup.sql
│
├── scripts/                          ← Helper scripts
│   └── pdf_ingest.py                    (converts PDFs → webhook)
│
├── benchmark/                        ← Optional: test similarity algorithms
│   └── STEP4_similarity_benchmark.py
│
├── .env.example                      ← Copy to .env and fill in your keys
└── README.md
```

---

## Setup in 5 Steps

### Step 0 — Create your .env file (2 min)

```bash
cp .env.example .env
```

Then open `.env` and fill in:
- `WEBHOOK_URL` — your n8n webhook URL (set after Step 2)
- `OPENAI_API_KEY` — from platform.openai.com
- `SUPABASE_URL` — from Supabase → Project Settings → API
- `SUPABASE_ANON_KEY` — from Supabase → Project Settings → API

---

### Step 1 — Database Setup (5 min)

```
1. Open → database/STEP1_supabase_setup.sql
2. Copy entire contents
3. Paste into Supabase SQL Editor → Run
4. You'll see: "Setup complete!"
```

What this creates:
- `documents` table — stores your text chunks + embeddings
- `n8n_chat_histories` table — stores conversation memory
- Deduplication trigger — prevents the same content being stored twice
- 3 search functions — cosine, euclidean, dot product (for benchmarking)

---

### Step 2 — Import n8n Workflows (10 min)

```
n8n → New Workflow → ⋯ → Import from file

① Import: n8n-workflows/STEP2_ingestion_workflow.json
   └── Set credentials: Supabase + OpenAI → Save → ACTIVATE

② Import: n8n-workflows/STEP3_chat_workflow.json
   └── Set credentials: OpenAI + Postgres + Supabase → Save → ACTIVATE
```

> **Important:** Both workflows must be ACTIVATED (toggle in top right of n8n).
> Copy the webhook URL from STEP2 and paste it into your `.env` as `WEBHOOK_URL`.

---

### Step 3 — Ingest Your PDFs (2 min)

Your CV is already in the `/knowledge` folder. Run the PDF ingestion script:

```bash
pip install pdfplumber requests python-dotenv
cd scripts/
python pdf_ingest.py
```

This will:
1. Read every PDF in `/knowledge`
2. Extract the text from each page
3. POST the text to your n8n webhook automatically
4. n8n chunks it, embeds it, and stores it in Supabase

To ingest a specific file:
```bash
python pdf_ingest.py ../knowledge/Keerthivanan\ CV.pdf
```

Or send text manually via curl:
```bash
curl -X POST YOUR_WEBHOOK_URL \
  -H "Content-Type: application/json" \
  -d '{"text": "paste your content here", "source": "CV"}'
```

---

### Step 4 — Chat!

```
Go to n8n → STEP3 Chat Workflow → Click the Chat button (bottom right)
Ask anything → AI answers from YOUR documents only
```

**About Session IDs:**
Each browser tab gets its own `sessionId`, which keeps conversations separate.
The AI remembers the last 10 messages per session. To start fresh, open a new tab.

---

### Step 5 — Optional: Similarity Benchmark

After ingesting data, compare all 3 search algorithms:

```bash
cd benchmark/
pip install openai supabase python-dotenv
python STEP4_similarity_benchmark.py
```

Expected output:
```
🔵 COSINE      | 0.9412 | "AI skills: OpenAI, LangChain, n8n..."
🟢 EUCLIDEAN   | 0.8734 | "AI skills: OpenAI, LangChain, n8n..."
🟡 DOT PRODUCT | 0.9103 | "AI skills: OpenAI, LangChain, n8n..."
🏆 WINNER: COSINE
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Orchestration | n8n (self-hosted) |
| Vector Database | Supabase pgvector |
| LLM | OpenAI GPT-4o |
| Embeddings | OpenAI text-embedding-3-small |
| Memory | PostgreSQL Chat Memory (Supabase) |
| Chat UI | n8n built-in Chat Trigger |
| PDF Extraction | pdfplumber (Python) |

---

## How Deduplication Works

If you run `pdf_ingest.py` twice by mistake, the database will NOT store duplicate chunks.

The SQL trigger automatically computes an MD5 hash of each text chunk on insert.
If that hash already exists, the insert is silently skipped — no error, no duplicates.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Function not found" | Re-run `database/STEP1_supabase_setup.sql` |
| "No results from search" | Run `scripts/pdf_ingest.py` to ingest documents first |
| "AI hallucinating" | Check system prompt in AI Agent node in n8n |
| Python script fails | Make sure `.env` file exists and all keys are filled in |
| "No text extracted" from PDF | PDF may be scanned/image-based — manually copy-paste text instead |
| Webhook returns 400 | Request body is missing `text` or `content` field |
| n8n workflow not running | Make sure both workflows are ACTIVATED in n8n |
