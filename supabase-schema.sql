-- Cantinho da Sarah — estrutura do álbum Shadow & Sky
-- Execute este arquivo no Supabase > SQL Editor > New query > Run.
-- O bucket é privado; os uploads e consultas são feitos pelo servidor usando a chave secreta.

create extension if not exists pgcrypto;

create table if not exists public.album_photos (
    id uuid primary key default gen_random_uuid(),
    pet text not null check (pet in ('shadow', 'sky')),
    caption varchar(250) not null default '',
    storage_path text not null unique,
    created_at timestamptz not null default now()
);

create index if not exists album_photos_created_at_idx
    on public.album_photos (created_at desc);

create index if not exists album_photos_pet_idx
    on public.album_photos (pet);

alter table public.album_photos enable row level security;

grant usage on schema public to service_role;
grant all on table public.album_photos to service_role;

-- Cria ou atualiza o bucket privado usado pelo server.js.
insert into storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
values (
    'sarah-album',
    'sarah-album',
    false,
    15728640,
    array[
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif'
    ]::text[]
)
on conflict (id) do update set
    name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Não são criadas políticas públicas para anon/authenticated.
-- O servidor usa a chave secreta e gera URLs temporárias para exibir fotos.
