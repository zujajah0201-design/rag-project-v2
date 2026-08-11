const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

async function extractText() {
  const inputPath = path.join(__dirname, '..', 'documents', 'Harborlight_HomeGuard_Plus_Policy.docx');
  const outputPath = path.join(__dirname, '..', 'documents', 'handbook.txt');

  const result = await mammoth.extractRawText({ path: inputPath });
  fs.writeFileSync(outputPath, result.value);

  console.log('Text extracted successfully!');
  console.log('Preview:', result.value.slice(0, 300));
}

extractText().catch(err => console.error('Extraction failed:', err.message));