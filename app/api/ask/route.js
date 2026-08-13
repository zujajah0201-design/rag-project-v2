import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

// OpenRouter exposes an OpenAI-compatible API, so we point the AI SDK's
// OpenAI provider at it instead of api.openai.com.
const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME;

// A separate, smaller model just for title generation. The main
// OPENROUTER_MODEL (Nemotron 3 Ultra) is a reasoning model whose thinking
// mode is controlled via an internal chat-template flag rather than a
// system-prompt string, so it can't reliably be told to skip straight to a
// short answer over the API - it kept spending the whole output budget on
// hidden reasoning tokens and returning nothing visible. A plain instruct
// model is a much better fit for a "shorten this into 3 words" task anyway.
// Override with OPENROUTER_TITLE_MODEL if you want to point this elsewhere.
const TITLE_MODEL = process.env.OPENROUTER_TITLE_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

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

// Fallback title if the LLM call fails - just a plain truncation.
function truncateTitle(question) {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

// Makes a single attempt at the title call. Returns the sanitized title,
// or '' if the model gave back nothing usable (caller decides whether to
// retry or fall back).
async function attemptGenerateTitle(question) {
  const result = streamText({
    model: openrouter(TITLE_MODEL),
    temperature: 0.2,
    maxOutputTokens: 40,
    messages: [
      {
        role: 'system',
        content:
          'Turn the user\'s message into a 2-5 word chat title, Title Case, no punctuation, no commentary - just the title.\n' +
          'Example - Message: "Does this policy cover flood damage?" -> Title: Flood Damage Coverage',
      },
      { role: 'user', content: question },
    ],
  });

  let raw = '';
  for await (const delta of result.textStream) {
    raw += delta;
  }
  return sanitizeTitle(raw);
}

// Ask the LLM itself to summarize the opening question into a short title,
// instead of just cutting the text off at N characters. Retries once on an
// empty completion before giving up - free-tier OpenRouter models have
// been observed to intermittently return nothing for this call even when
// the same prompt succeeds moments later.
async function generateChatTitle(question) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cleaned = await attemptGenerateTitle(question);
      if (cleaned) return cleaned;
      console.warn(`Title generation attempt ${attempt} returned empty/unusable output.`);
    } catch (err) {
      console.error(`Title generation attempt ${attempt} failed:`, err);
    }
  }
  return truncateTitle(question);
}

// Normalizes a cleaned title string into consistent Title Case, so the
// output doesn't purely depend on the model following instructions.
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

// Defends against the model ignoring instructions and echoing a full
// sentence/preamble instead of a short title.
function sanitizeTitle(raw) {
  let t = raw.trim();

  // Strip common preambles some models add despite instructions.
  t = t.replace(/^(title|chat title)\s*:\s*/i, '');
  t = t.replace(/^(the user is asking about|this (chat|conversation) is about|about)\s*:?\s*/i, '');

  // Strip wrapping quotes and trailing punctuation.
  t = t.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '');
  t = t.replace(/[.?!]+$/g, '');

  // Only keep the first line, in case the model added extra commentary.
  t = t.split('\n')[0].trim();

  // Hard cap the word count so a runaway sentence never slips through.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 6) {
    t = words.slice(0, 6).join(' ');
  }

  return t ? toTitleCase(t) : '';
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
      // Insert immediately with a fast placeholder title so streaming can
      // start right away - the real LLM-generated title is filled in below,
      // in the background, without blocking the answer.
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

    // Save the user's turn right away, so it's not lost if the stream fails
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

    // NOTE: title generation is intentionally NOT kicked off here in
    // parallel with the answer stream anymore. Running two simultaneous
    // requests against the same (often free-tier/rate-limited) OpenRouter
    // model caused the title call to silently come back with an empty
    // completion - no error, just nothing to work with. It's kicked off
    // sequentially below, only after the answer stream finishes.

    // Custom SSE stream: a "meta" frame with chat/source info up front,
    // "delta" frames as the model's answer streams in, then the "title"
    // frame (once background title generation finishes), and finally
    // "done" - kept as the LAST event so a frontend that stops reading on
    // "done" still receives the real title beforehand.
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

        // Now that the answer call to OpenRouter is fully done, it's safe
        // to make the title call - sequential, so it never competes with
        // the answer stream for the same rate-limited model/key.
        if (isNewChat) {
          try {
            const finalTitle = await generateChatTitle(question);
            if (finalTitle && finalTitle !== chat.title) {
              await supabase.from('chats').update({ title: finalTitle }).eq('id', chat.id);
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