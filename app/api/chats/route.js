import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

// GET /api/chats - list the current user's past chats, most recent first
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('chats')
    .select('id, title, created_at, updated_at')
    .eq('user_id', session.user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ chats: data });
}

// POST /api/chats - start a new, empty chat
export async function POST(req) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const title = body?.title?.trim() || 'New chat';

  const { data, error } = await supabase
    .from('chats')
    .insert([{ user_id: session.user.id, title }])
    .select()
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ chat: data });
}
