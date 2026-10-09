export interface Lead {
  id: string;
  phone_number: string;
  name: string;
  status: string;
  created_at: string;
}

export interface Message {
  id: string;
  lead_id: string;
  type: 'human' | 'ai' | 'system';
  content: string;
  created_at: string;
}
