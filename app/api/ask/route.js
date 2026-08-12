import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText } from 'ai';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME;

let embedder;
async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

async function embedText(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function truncateTitle(question) {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

function toTitleCase(str) {
  const smallWords = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'and', 'or', 'for']);
  return str
    .split(' ')
    .map((word, i) => {
      if (i !== 0 && smallWords.has(word.toLowerCase())) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

// Extract keywords from the question as a last-resort fallback
function keywordTitle(question) {
  const stopWords = new Set([
    'a','an','the','is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','could','should','may','might','must','shall',
    'can','need','dare','ought','used','to','of','in','for','on','with','at','by',
    'from','as','into','through','during','before','after','above','below','between',
    'under','again','further','then','once','here','there','when','where','why','how',
    'all','each','few','more','most','other','some','such','no','nor','not','only',
    'own','same','so','than','too','very','just','and','but','if','or','because',
    'until','while','what','which','who','whom','this','that','these','those','am',
    'it','its','i','me','my','myself','we','our','ours','ourselves','you','your',
    'yours','yourself','yourselves','he','him','his','himself','she','her','hers',
    'herself','they','them','their','theirs','themselves','give','get','tell','show',
    'explain','describe','small','big','large','about','regarding','question','inquiry',
    'ask','asking','tell','me','us','my','your'
  ]);

  const words = question.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (words.length === 0) return truncateTitle(question);

  // Deduplicate while preserving order
  const seen = new Set();
  const unique = words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });

  return toTitleCase(unique.slice(0, 4).join(' '));
}

function sanitizeTitle(raw) {
  if (!raw) return '';
  let t = raw.trim();

  // Strip any "Title:" prefix
  t = t.replace(/^(title|chat title|topic)\s*[:：]\s*/i, '');

  // Strip wrapping quotes
  t = t.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '');

  // Strip trailing punctuation
  t = t.replace(/[.?!]+$/, '');

  // First line only
  t = t.split('\n')[0].trim();

  // Hard word cap
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 6) t = words.slice(0, 6).join(' ');

  // Reject only obvious meta-commentary
  if (/^(the user|this is|here is|below is|above is)\b/i.test(t)) return '';

  return t ? toTitleCase(t) : '';
}

async function generateChatTitle(question) {
  try {
    const { text } = await generateText({
      model: openrouter(process.env.OPENROUTER_MODEL),
      temperature: 0.1,
      maxOutputTokens: 20,
      messages: [
        {
          role: 'system',
          content:
            'Generate a 2-4 word chat title in Title Case. No punctuation. No explanation. Output ONLY the title text.',
        },
        {
          role: 'user',
          content: `Message: "${question}"\nTitle:`,
        },
      ],
    });

    console.log('[TITLE] Raw LLM output:', JSON.stringify(text));
    const cleaned = sanitizeTitle(text);
    console.log('[TITLE] Cleaned:', JSON.stringify(cleaned));

    if (cleaned) return cleaned;
  } catch (err) {
    console.error('[TITLE] generateText failed:', err);
  }

  // Final fallback: keyword extraction (way better than raw truncation)
  const fallback = keywordTitle(question);
  console.log('[TITLE] Keyword fallback:', JSON.stringify(fallback));
  return fallback;
}

const encoder = new TextEncoder();
function sseFrame(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { question, chatId } = await req.json();
    if (!question) {
      return Response.json({ error: 'Question is required' }, { status: 400 });
    }

    let chat;
    let isNewChat = false;
    if (chatId) {
      const { data, error } = await supabase
        .from('chats')
        .select('id, user_id, title')
        .eq('id', chatId)
        .single();

      if (error || !data || String(data.user_id) !== String(session.user.id)) {
        return Response.json({ error: 'Chat not found' }, { status: 404 });
      }
      chat = data;
    } else {
      const placeholder = truncateTitle(question);
      const { data, error } = await supabase
        .from('chats')
        .insert([{ user_id: session.user.id, title: placeholder }])
        .select()
        .single();

      if (error) {
        return Response.json({ error: error.message }, { status: 500 });
      }
      chat = data;
      isNewChat = true;
    }

    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chat.id)
      .order('created_at', { ascending: true });

    const queryVector = await embedText(question);

    const searchResponse = await qdrant.query(COLLECTION_NAME, {
      query: queryVector,
      limit: 3,
      with_payload: true,
    });

    const results = searchResponse.points;
    const context = results.map((r) => r.payload.text).join('\n\n');
    const sources = results.map((r) => r.payload.text);

    await supabase.from('messages').insert([
      { chat_id: chat.id, role: 'user', content: question },
    ]);

    const result = streamText({
      model: openrouter(process.env.OPENROUTER_MODEL),
      temperature: 0.2,
      maxOutputTokens: 500,
      messages: [
        {
          role: 'system',
          content:
            "You are a helpful assistant that answers questions about the Harborlight HomeGuard Plus homeowners insurance policy. Only use the provided context to answer. If the answer is not in the context, say you don't know. Do not make up information. Format your answers in markdown (use **bold**, bullet points, etc. where it helps readability).",
        },
        ...(history || []).map((m) => ({ role: m.role, content: m.content })),
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion: ${question}`,
        },
      ],
      onFinish: async ({ text }) => {
        await supabase.from('messages').insert([
          { chat_id: chat.id, role: 'assistant', content: text, sources },
        ]);
        await supabase
          .from('chats')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', chat.id);
      },
    });

    const titlePromise = isNewChat ? generateChatTitle(question) : null;

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          sseFrame('meta', { chatId: chat.id, chatTitle: chat.title, sources })
        );

        let streamErrored = false;
        try {
          for await (const delta of result.textStream) {
            controller.enqueue(sseFrame('delta', { text: delta }));
          }
        } catch (err) {
          streamErrored = true;
          controller.enqueue(sseFrame('error', { message: err.message }));
        }

        if (titlePromise) {
          try {
            const finalTitle = await titlePromise;
            // Always update DB and send event if we have a title,
            // even if it happens to match (ensures frontend consistency)
            if (finalTitle) {
              await supabase
                .from('chats')
                .update({ title: finalTitle })
                .eq('id', chat.id);
              controller.enqueue(
                sseFrame('title', { chatId: chat.id, title: finalTitle })
              );
            }
          } catch (err) {
            console.error('Background title update failed:', err);
          }
        }

        if (!streamErrored) {
          controller.enqueue(sseFrame('done', {}));
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Error in /api/ask:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}