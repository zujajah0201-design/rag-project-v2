import bcrypt from 'bcryptjs';
import { supabase } from '@/lib/supabase';

export async function POST(req) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return Response.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return Response.json({ error: 'User already exists' }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const { error } = await supabase
      .from('users')
      .insert([{ email, password: hashedPassword }]);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ message: 'User created successfully' });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}