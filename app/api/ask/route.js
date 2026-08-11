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

// OpenRouter exposes an OpenAI-compatible API, so we point the AI SDK's
// OpenAI provider at it instead of api.openai.com.
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

// Fallback title if the LLM call fails - just a plain truncation.
function truncateTitle(question) {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

// Ask the LLM itself to summarize the opening question into a short title,
// instead of just cutting the text off at N characters.
async function generateChatTitle(question) {
  try {
    const { text } = await generateText({
      model: openrouter(process.env.OPENROUTER_MODEL),
      temperature: 0.2,
      maxOutputTokens: 12,
      messages: [
        {
          role: 'system',
          content:
            'You convert a user question into a short chat title, 2-5 words, Title Case. ' +
            'Output ONLY the title itself - no quotes, no punctuation, no prefix like "Title:" ' +
            'or "The user is asking about", no explanation. Just the bare title words.\n\n' +
            'Example question: "What is my deductible amount?"\n' +
            'Example title: Deductible Amount\n\n' +
            'Example question: "Does this policy cover flood damage?"\n' +
            'Example title: Flood Coverage',
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

  return t;
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
      const generatedTitle = await generateChatTitle(question);
      const { data, error } = await supabase
        .from('chats')
        .insert([{ user_id: session.user.id, title: generatedTitle }])
        .select()
        .single();

      if (error) {
        return Response.json({ error: error.message }, { status: 500 });
      }
      chat = data;
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

    // Custom SSE stream: a "meta" frame with chat/source info up front,
    // then "delta" frames as the model's answer streams in.
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          sseFrame('meta', { chatId: chat.id, chatTitle: chat.title, sources })
        );
        try {
          for await (const delta of result.textStream) {
            controller.enqueue(sseFrame('delta', { text: delta }));
          }
          controller.enqueue(sseFrame('done', {}));
        } catch (err) {
          controller.enqueue(sseFrame('error', { message: err.message }));
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