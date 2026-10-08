import Anthropic from '@anthropic-ai/sdk';
import { LLMError, type LLM, type LLMRequest, type LLMUsage } from './llm.js';

/** Real Claude over the Anthropic API. The key never leaves the server. */
export class AnthropicLLM implements LLM {
  readonly label = 'Claude on the floor';
  readonly real = true;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });
  }

  async stream(req: LLMRequest, onText: (delta: string) => void): Promise<LLMUsage> {
    try {
      const stream = this.client.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [{ role: 'user', content: req.prompt }],
        ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      }, { signal: req.signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new LLMError('refused', 'Claude declined this request');
      return { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, stopReason: msg.stop_reason, model: msg.model };
    } catch (e) {
      if (e instanceof LLMError) throw e;
      if (e instanceof Anthropic.APIUserAbortError || req.signal?.aborted) throw new LLMError('cancelled', 'cancelled');
      if (e instanceof Anthropic.RateLimitError) throw new LLMError('rate_limited', e.message);
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LLMError('auth', e.message);
      if (e instanceof Anthropic.InternalServerError) throw new LLMError('overloaded', e.message);
      if (e instanceof Anthropic.APIError) throw new LLMError('error', e.message);
      throw new LLMError('error', String((e as Error)?.message || e));
    }
  }
}
