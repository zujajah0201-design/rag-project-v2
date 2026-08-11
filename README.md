# Harborlight HomeGuard AI — RAG Policy Assistant

A Retrieval-Augmented Generation (RAG) chatbot that answers questions about the Harborlight HomeGuard Plus homeowners insurance policy, built with Next.js, Qdrant Cloud, and OpenRouter.

## Stack

- **Frontend/Backend:** Next.js (App Router)
- **Vector Database:** Qdrant Cloud
- **LLM API:** OpenRouter (`nvidia/nemotron-3-ultra-550b-a55b:free`)
- **Embeddings:** `Xenova/all-MiniLM-L6-v2` (local, via `@xenova/transformers`)
- **Document parsing:** `mammoth` (`.docx` → text)

## How it works

1. **Indexing** (`scripts/indexDocs.js`) — extracts text from the policy `.docx`, splits it into overlapping chunks, generates embeddings for each chunk, and stores them in a Qdrant Cloud collection.
2. **Retrieval + Generation** (`app/api/ask/route.js`) — embeds the user's question, searches Qdrant for the most similar chunks (cosine similarity), and sends those chunks plus the question to an LLM via OpenRouter with a system prompt that restricts answers to the provided context.
3. **Frontend** (`app/page.tsx`) — simple chat interface for asking questions.

## Environment variables

Create a `.env.local` file with:
QDRANT_URL=https://18d9fbfd-64cb-47a8-9cb5-21ec06e691b3.sa-east-1-0.aws.cloud.qdrant.io:6333
QDRANT_API_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6YzU3MWU3NzItYWFlMy00MWRiLTk1NzgtODEyOTM3MWI0MzY3In0.pP16oDVFc0y-kb3bX3Mb2ekGo3nNE2jQomhd3RBuD6U
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
QDRANT_COLLECTION_NAME=harborlight_policy

## Setup

```bash
npm install
node scripts/extractText.js
node scripts/indexDocs.js
npm run dev
```

Visit `http://localhost:3000`.

## Author

Zujajah Sana — COMSATS University Islamabad, Wah Campus

Save it, close Notepad.

Push the update
bash
git add README.md
git commit -m "Add proper project README"
git push

Go ahead and do this — send a screenshot once pushed, and your repo will look complete and professional for submission.