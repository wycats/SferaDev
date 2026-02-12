export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  name: string;
  description: string;
  context_window: number;
  max_tokens: number;
  type?: string;
  tags?: string[];
  pricing: {
    input: string;
    output: string;
  };
}
