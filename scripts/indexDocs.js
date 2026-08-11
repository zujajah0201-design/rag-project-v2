require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const path = require('path');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

const COLLECTION_NAME = 'harborlight_policy';

function chunkText(text, chunkSize = 500, overlap = 50) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = start + chunkSize;
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  return chunks;
}

let embedder;
async function getEmbedder() {
  if (!embedder) {
    console.log('Loading embedding model (first run may take a minute)...');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

async function embedText(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

async function indexDocuments() {
  const textPath = path.join(__dirname, '..', 'documents', 'handbook.txt');
  const text = fs.readFileSync(textPath, 'utf-8');
  const chunks = chunkText(text);

  console.log(`Split into ${chunks.length} chunks`);

  const collections = await client.getCollections();
  const exists = collections.collections.some(c => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: 384, distance: 'Cosine' },
    });
    console.log('Collection created');
  } else {
    console.log('Collection already exists, will add/update points');
  }

  const points = [];
  for (let i = 0; i < chunks.length; i++) {
    const vector = await embedText(chunks[i]);
    points.push({
      id: i,
      vector,
      payload: { text: chunks[i] },
    });
    console.log(`Embedded chunk ${i + 1}/${chunks.length}`);
  }

  await client.upsert(COLLECTION_NAME, { points });
  console.log(`Successfully indexed ${points.length} chunks into Qdrant!`);
}

indexDocuments().catch(err => console.error('Indexing failed:', err.message));