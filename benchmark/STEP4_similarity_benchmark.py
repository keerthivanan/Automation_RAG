#!/usr/bin/env python3
"""
RAG Similarity Search Benchmark
Tests Cosine vs Euclidean vs Dot Product on your Supabase vector store

Setup:
  1. Copy .env.example to .env and fill in your keys
  2. pip install openai supabase python-dotenv
  3. python STEP4_similarity_benchmark.py
"""

import json
import os
import sys
from openai import OpenAI
from supabase import create_client
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# ─── CONFIG — loaded from environment variables ─────────────────
OPENAI_API_KEY  = os.environ.get("OPENAI_API_KEY")
SUPABASE_URL    = os.environ.get("SUPABASE_URL")
SUPABASE_KEY    = os.environ.get("SUPABASE_ANON_KEY")
EMBED_MODEL     = os.environ.get("EMBED_MODEL", "text-embedding-3-small")
TOP_K           = int(os.environ.get("TOP_K", "6"))
# ────────────────────────────────────────────────────────────────

def validate_config():
    """Check all required env vars are set before running."""
    missing = []
    if not OPENAI_API_KEY  or OPENAI_API_KEY.startswith("sk-..."):
        missing.append("OPENAI_API_KEY")
    if not SUPABASE_URL    or "xxx" in SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not SUPABASE_KEY    or SUPABASE_KEY == "your-anon-key":
        missing.append("SUPABASE_ANON_KEY")

    if missing:
        print("\n❌  Missing environment variables:")
        for var in missing:
            print(f"    - {var}")
        print("\n👉  Create a .env file in this folder with:")
        print("    OPENAI_API_KEY=sk-...")
        print("    SUPABASE_URL=https://xxx.supabase.co")
        print("    SUPABASE_ANON_KEY=your-anon-key")
        sys.exit(1)

# Test questions — customize these for your knowledge base!
TEST_QUESTIONS = [
    "What programming languages does the person know?",
    "What AI tools and frameworks have been used?",
    "What automation experience is there?",
    "Describe the work experience and projects.",
    "What are the key technical skills?",
]

def embed(text: str, client: OpenAI) -> list:
    """Convert text to vector using OpenAI embeddings."""
    res = client.embeddings.create(model=EMBED_MODEL, input=text)
    return res.data[0].embedding

def search(fn_name: str, vector: list, supabase) -> list:
    """Run a similarity search using a named SQL function."""
    try:
        result = supabase.rpc(fn_name, {
            "query_embedding": vector,
            "match_threshold": 0.0,
            "match_count": TOP_K
        }).execute()
        return result.data or []
    except Exception as e:
        print(f"  ⚠️  {fn_name} error: {e}")
        return []

def run_benchmark():
    validate_config()

    # Init clients
    client   = OpenAI(api_key=OPENAI_API_KEY)
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    results   = []
    wins      = {"cosine": 0, "euclidean": 0, "dot_product": 0}
    consensus = []

    print("\n" + "="*70)
    print("🔬  RAG SIMILARITY SEARCH BENCHMARK")
    print("="*70)
    print(f"Model: {EMBED_MODEL}  |  TopK: {TOP_K}")
    print("="*70)

    for i, question in enumerate(TEST_QUESTIONS, 1):
        print(f"\n[{i}/{len(TEST_QUESTIONS)}] ❓ {question}")
        print("-" * 60)

        # Embed once, reuse for all 3 searches
        vector = embed(question, client)

        r_cos = search("match_cosine",      vector, supabase)
        r_euc = search("match_euclidean",   vector, supabase)
        r_dot = search("match_dot_product", vector, supabase)

        if not r_cos and not r_euc and not r_dot:
            print("  ⚠️  No results returned. Make sure you have ingested documents first.")
            continue

        # Top results
        cos_top = r_cos[0] if r_cos else {}
        euc_top = r_euc[0] if r_euc else {}
        dot_top = r_dot[0] if r_dot else {}

        cos_score = float(cos_top.get("similarity", 0))
        euc_score = float(euc_top.get("similarity", 0))
        dot_score = float(dot_top.get("similarity", 0))

        print(f"  🔵 COSINE      | {cos_score:.4f} | {str(cos_top.get('content',''))[:70]}...")
        print(f"  🟢 EUCLIDEAN   | {euc_score:.4f} | {str(euc_top.get('content',''))[:70]}...")
        print(f"  🟡 DOT PRODUCT | {dot_score:.4f} | {str(dot_top.get('content',''))[:70]}...")

        # Consensus: IDs returned by all 3
        cos_ids = {r["id"] for r in r_cos}
        euc_ids = {r["id"] for r in r_euc}
        dot_ids = {r["id"] for r in r_dot}
        agree   = len(cos_ids & euc_ids & dot_ids)
        consensus.append(agree)
        print(f"  🤝 Agreement: {agree}/{TOP_K} chunks returned by all 3 algorithms")

        # Pick winner for this question
        winner = max(
            ("cosine",      cos_score),
            ("euclidean",   euc_score),
            ("dot_product", dot_score),
            key=lambda x: x[1]
        )[0]
        wins[winner] += 1

        results.append({
            "question":         question,
            "cosine_score":     round(cos_score, 4),
            "euclidean_score":  round(euc_score, 4),
            "dot_score":        round(dot_score, 4),
            "consensus_chunks": agree,
            "winner":           winner
        })

    if not results:
        print("\n❌  No results to summarize. Ingest some documents first.")
        return

    # ── SUMMARY ──────────────────────────────────────────────
    print("\n" + "="*70)
    print("📊  BENCHMARK RESULTS SUMMARY")
    print("="*70)
    for algo, count in wins.items():
        bar   = "█" * (count * 5)
        label = "✅ WINNER" if count == max(wins.values()) else ""
        print(f"  {algo:<15} {bar:<30} ({count}/{len(results)} wins) {label}")

    overall_winner = max(wins, key=wins.get)
    avg_consensus  = round(sum(consensus) / len(consensus), 1) if consensus else 0

    print(f"\n  🏆 WINNING ALGORITHM   : {overall_winner.upper()}")
    print(f"  🤝 AVG CHUNK AGREEMENT : {avg_consensus}/{TOP_K} per question")
    print(f"\n  👉 RECOMMENDATION: Use '{overall_winner}' in your n8n production RAG")
    print("="*70)

    # Save results
    out_path = os.path.join(os.path.dirname(__file__), "benchmark_results.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n  ✅ Full results saved → {out_path}\n")

if __name__ == "__main__":
    run_benchmark()
