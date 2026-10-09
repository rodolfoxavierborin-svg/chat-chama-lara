// src/types.ts ou src/types.d.ts

export interface Lead {
  id: string;
  name?: string | null;
  phone_number?: string | null;
  phone?: string | null;
  ultima_interacao?: string | null;
  'última_interação'?: string | null;
  created_at?: string | null;
  is_paused?: boolean; // Propriedade que estava causando o erro no build
  avatar_url?: string | null;
  photo_url?: string | null;
  profile_pic?: string | null;
  
  // Index signature para permitir qualquer outro campo extra vindo do Supabase sem quebrar o TypeScript
  [key: string]: any;
}

export interface Message {
  id: string | number;
  lead_id: string;
  type?: string;
  content?: string | any;
  message?: string;
  created_at?: string;
  
  [key: string]: any;
}