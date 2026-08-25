CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  identity_key text NOT NULL,
  signed_prekey text NOT NULL,
  signed_prekey_sig text NOT NULL,
  registration_id integer NOT NULL DEFAULT 0,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS one_time_prekeys (
  id serial PRIMARY KEY,
  device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
  prekey_id integer NOT NULL,
  public_key text NOT NULL,
  consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  is_group boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  device_ids text[] DEFAULT ARRAY[]::text[],
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user uuid REFERENCES users(id),
  sender_device text,
  message_id text NOT NULL,
  ciphertext bytea NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  server_received_at timestamptz NOT NULL DEFAULT now(),
  delivered boolean NOT NULL DEFAULT false,
  seen boolean NOT NULL DEFAULT false,
  expires_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages (expires_at);

CREATE TABLE IF NOT EXISTS message_revisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friendships (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a uuid REFERENCES users(id) ON DELETE CASCADE,
  user_b uuid REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS notifications (
  id serial PRIMARY KEY,
  channel text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
