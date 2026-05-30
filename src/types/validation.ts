import { z } from 'zod';

export const ChatCompletionSchema = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string().max(50000), z.array(z.record(z.string(), z.any()))]),
  })).min(1).max(200),
  stream: z.boolean().optional(),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.any()).optional(),
    }),
  })).max(50).optional(),
  tool_choice: z.union([z.string(), z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string() }),
  })]).optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  response_format: z.record(z.string(), z.any()).optional(),
  seed: z.number().int().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  n: z.number().int().optional(),
  user: z.string().optional(),
}).passthrough();

export function validateChatRequest(body: unknown) {
  return ChatCompletionSchema.safeParse(body);
}
