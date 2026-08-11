-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- Adds the tables needed for chat history / sidebar feature.
--
-- Note: user_id is stored as `text` on purpose so this works no matter
-- whether your existing `users.id` column is uuid, bigint, etc. There's no
-- FK constraint to `users` for the same reason -- ownership is enforced in
-- the API routes instead (every query filters by the logged-in user's id).

create extension if not exists pgcrypto;

create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chats_user_id_idx on chats(user_id);
create index if not exists messages_chat_id_idx on messages(chat_id);
