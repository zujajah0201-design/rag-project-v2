import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

async function getOwnedChat(chatId, userId) {
  const { data, error } = await supabase
    .from('chats')
    .select('id, title, user_id, created_at, updated_at')
    .eq('id', chatId)
    .single();

  if (error || !data || String(data.user_id) !== String(userId)) {
    return null;
  }
  return data;
}

// GET /api/chats/[id] - fetch one chat plus its full message history
export async function GET(req, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const chat = await getOwnedChat(id, session.user.id);
  if (!chat) {
    return Response.json({ error: 'Chat not found' }, { status: 404 });
  }

  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, role, content, sources, created_at')
    .eq('chat_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ chat, messages });
}

// DELETE /api/chats/[id] - remove a chat (and its messages, via cascade)
export async function DELETE(req, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const chat = await getOwnedChat(id, session.user.id);
  if (!chat) {
    return Response.json({ error: 'Chat not found' }, { status: 404 });
  }

  const { error } = await supabase.from('chats').delete().eq('id', id);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true });
}
