require('dotenv').config({ path: '.env.local' });
const { QdrantClient } = require('@qdrant/js-client-rest');

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

async function testConnection() {
  try {
    const result = await client.getCollections();
    console.log('Connected successfully!');
    console.log('Existing collections:', result.collections);
  } catch (error) {
    console.error('Connection failed:', error.message);
  }
}

testConnection();