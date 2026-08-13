import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText } from 'ai';  // ← generateText add kiya
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

function sanitizeTitle(raw) {
  if (!raw) return '';
  let t = raw.trim();

  // Strip common preambles some models add despite instructions
  t = t.replace(/^(title|chat title)\s*[:：]\s*/i, '');
  t = t.replace(/^(the user is asking about|this (chat|conversation) is about|about)\s*[:：]?\s*/i, '');

  // Strip wrapping quotes and trailing punctuation
  t = t.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '');
  t = t.replace(/[.?!]+$/, '');

  // Only keep the first line
  t = t.split('\n')[0].trim();

  // Hard cap word count
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 6) t = words.slice(0, 6).join(' ');

  // Reject if it's describing the user instead of being a title
  if (/\bthe user\b|\bthey (said|asked)\b|\bis asking\b|\buser asked\b/i.test(t)) return '';

  return t ? toTitleCase(t) : '';
}

// Fast path for greetings — no LLM call needed
function isGreeting(text) {
  const greetings = ['hi', 'hello', 'hey', 'hola', 'greetings', 'good morning', 'good afternoon', 'good evening'];
  const lower = text.trim().toLowerCase();
  return greetings.some(g => lower === g || lower.startsWith(g + ' ')) && lower.split(' ').length <= 3;
}

// KEY FIX: Use generateText (not streamText) — reliable for small outputs
async function generateChatTitle(question) {
  // Fast path: greetings ko "New Conversation" banao bina LLM call kiye
  if (isGreeting(question)) {
    return 'New Conversation';
  }

  try {
    const { text } = await generateText({
      model: openrouter(process.env.OPENROUTER_MODEL),
      temperature: 0.1, // Low = more deterministic, instructions follow better
      maxOutputTokens: 20,
      messages: [
        {
          role: 'system',
          content:
            'You are a chat title generator. Create a short, professional title for a conversation.\n\n' +
            'STRICT RULES:\n' +
            '- 2 to 5 words only\n' +
            '- Title Case (capitalize main words)\n' +
            '- No punctuation, no quotes, no explanation\n' +
            '- No filler words: About, Regarding, Question, Inquiry, User\n' +
            '- Describe the specific topic, not the app or general policy\n' +
            '- If the message is just a greeting, output exactly: New Conversation\n' +
            '- Output ONLY the title text, absolutely nothing else\n\n' +
            'Examples:\n' +
            'Message: "What is my deductible amount?" → Deductible Amount\n' +
            'Message: "Does this policy cover flood damage?" → Flood Damage Coverage\n' +
            'Message: "How do I file a claim after a break-in?" → Filing Burglary Claim\n' +
            'Message: "Can I add my dog to the liability coverage?" → Dog Liability Coverage\n' +
            'Message: "hi" → New Conversation',
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

    // Resolve the chat this message belongs to, or create a new one
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
      // Insert immediately with a fast placeholder title so streaming can start right away
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

    // Pull prior turns from this chat so the bot keeps conversational context
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
    const context = results.map(r => r.payload.text).join('\n\n');
    const sources = results.map(r => r.payload.text);

    // Save the user's turn right away
    await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: question }]);

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

    // Kick off title generation in parallel — NOT awaited so it never blocks the answer stream
    const titlePromise = isNewChat ? generateChatTitle(question) : null;

    // Custom SSE stream
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

        // Resolve and send the real title BEFORE "done"
        if (titlePromise) {
          try {
            const finalTitle = await titlePromise;
            if (finalTitle) {
              if (finalTitle !== chat.title) {
                await supabase.from('chats').update({ title: finalTitle }).eq('id', chat.id);
              }
              controller.enqueue(sseFrame('title', { chatId: chat.id, title: finalTitle }));
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