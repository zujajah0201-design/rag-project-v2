import { QdrantClient } from '@qdrant/js-client-rest';
import { env, pipeline } from '@xenova/transformers';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText } from 'ai';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
env.cacheDir = '/tmp/.transformers-cache';
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
const TITLE_MODEL = process.env.OPENROUTER_TITLE_MODEL || 'openrouter/free';

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

function sanitizeTitle(raw) {
  if (!raw) return '';
  let t = raw.trim();

  t = t.replace(/^(title|chat title)\s*[:：]\s*/i, '');
  t = t.replace(/^(the user is asking about|this (chat|conversation) is about|about)\s*[:：]?\s*/i, '');

  t = t.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '');
  t = t.replace(/[.?!]+$/, '');

  t = t.split('\n')[0].trim();

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 6) t = words.slice(0, 6).join(' ');

  if (/\bthe user\b|\bthey (said|asked)\b|\bis asking\b/i.test(t)) return '';

  return t ? toTitleCase(t) : '';
}

// Fast title via generateText on a separate lightweight model (runs in
// parallel with the answer stream and does not block first token).
async function generateChatTitle(question) {
  try {
    const { text } = await generateText({
      model: openrouter(TITLE_MODEL),
      temperature: 0.2,
      maxOutputTokens: 24,
      messages: [
        {
          role: 'system',
          content:
            'You generate short chat titles. Output ONLY the title text — no quotes, no explanation, no preamble.\n\n' +
            'Rules:\n' +
            '- 2 to 5 words.\n' +
            '- Title Case.\n' +
            '- Specific topic only; no filler words like "About" or "Question".\n' +
            '- No punctuation.\n\n' +
            'Examples:\n' +
            'What is my deductible amount? → Deductible Amount\n' +
            'Does this policy cover flood damage? → Flood Damage Coverage\n' +
            'How do I file a claim after a break-in? → Filing Burglary Claim\n' +
            'Can I add my dog to liability coverage? → Dog Liability Coverage\n' +
            'hi → New Conversation\n' +
            'hello → New Conversation\n\n' +
            'If the message is a greeting or has no clear topic, output exactly: New Conversation',
        },
        { role: 'user', content: question },
      ],
    });

    const cleaned = sanitizeTitle(text);
    return cleaned || truncateTitle(question);
  } catch (err) {
    console.error('Title generation failed, falling back to truncation:', err);
    return truncateTitle(question);
  }
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
      const { data, error } = await supabase
        .from('chats')
        .insert([{ user_id: session.user.id, title: truncateTitle(question) }])
        .select()
        .single();

      if (error) {
        return Response.json({ error: error.message }, { status: 500 });
      }
      chat = data;
      isNewChat = true;
    }

    // Fetch history, embed query, and save user message in parallel.
    const [{ data: history }, queryVector] = await Promise.all([
      supabase
        .from('messages')
        .select('role, content')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: true }),
      embedText(question),
      supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: question }]),
    ]);

    const searchResponse = await qdrant.query(COLLECTION_NAME, {
      query: queryVector,
      limit: 3,
      with_payload: true,
    });

    const results = searchResponse.points;
    const context = results.map(r => r.payload.text).join('\n\n');
    const sources = results.map(r => r.payload.text);

    const result = streamText({
      model: openrouter(process.env.OPENROUTER_MODEL),
      temperature: 0.2,
      maxOutputTokens: 500,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant that answers questions about the Harborlight HomeGuard Plus homeowners insurance policy. Only use the provided context to answer. If the answer is not in the context, say you don\'t know. Do not make up information. Format your answers in markdown (use **bold**, bullet points, etc. where it helps readability).',
        },
        ...(history || []).map(m => ({ role: m.role, content: m.content })),
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
            if (finalTitle) {
              await supabase.from('chats').update({ title: finalTitle }).eq('id', chat.id);
              if (finalTitle !== chat.title) {
                controller.enqueue(sseFrame('title', { chatId: chat.id, title: finalTitle }));
              }
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
