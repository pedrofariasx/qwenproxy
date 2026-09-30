import test from 'node:test';
import assert from 'node:assert';
import { Hono } from 'hono';
import {
  isDailyQuotaAssistantMessage,
  couldBeDailyQuotaAssistantMessagePrefix,
} from '../utils/qwen-quota-message.js';
import {
  handleStreamingResponse,
  collectNonStreamingResult,
} from '../routes/stream-handler.js';
import {
  getStream,
  registerStream,
  removeStream,
} from '../core/stream-registry.js';

function sseStream(content: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: {"choices":[{"delta":{"phase":"answer","content":${JSON.stringify(content)}}}]}\n\n`,
      ));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function registerTestStream(completionId: string, accountId: string): void {
  registerStream(completionId, {
    abortController: new AbortController(),
    accountId,
    uiSessionId: `${completionId}-session`,
    targetResponseId: '',
    headers: {},
    stopToken: 'test-token',
  });
}

test('daily quota classifier recognizes provider notices and rejects quoted/explanatory prose', () => {
  const positives = [
    'Você atingiu o limite de chats de hoje. Tente novamente amanhã.',
    'Você atingiu seu limite diário de chats. Tente novamente amanhã.',
    'Você chegou ao limite de mensagens de hoje. Volte amanhã.',
    'O limite diário de conversas foi atingido. Tente novamente amanhã.',
    "You've reached today's chat limit. Try again tomorrow.",
    'You have reached your daily chat limit. Please try again tomorrow.',
    "You've hit today's message limit. Check back tomorrow.",
    'Your daily conversation limit has been reached. Come back tomorrow.',
  ];
  for (const value of positives) {
    assert.strictEqual(isDailyQuotaAssistantMessage(value), true, value);
  }

  const negatives = [
    'If you have reached your daily chat limit, please try again tomorrow.',
    'The service may say: You have reached your daily chat limit. Please try again tomorrow.',
    '> You have reached your daily chat limit. Please try again tomorrow.',
    '"You have reached your daily chat limit. Please try again tomorrow." is the message users report seeing.',
    'Your implementation should detect quota responses and retry tomorrow.',
    'Você pode resolver isso com um retry amanhã.',
  ];
  for (const value of negatives) {
    assert.strictEqual(isDailyQuotaAssistantMessage(value), false, value);
  }
});

test('daily quota prefix probe only holds plausible provider-message prefixes', () => {
  const plausible = [
    'V',
    'Você atingiu',
    'Você atingiu seu limite diário de',
    'You',
    'You have reached your daily',
    "You've hit today's message",
    'Your daily conversation limit',
    'O limite diário de chats',
  ];
  for (const value of plausible) {
    assert.strictEqual(couldBeDailyQuotaAssistantMessagePrefix(value), true, value);
  }

  const ordinary = [
    'Here is the review',
    'You are looking at a normal answer',
    'Your implementation should detect quota responses',
    'Você pode resolver isso com um retry',
  ];
  for (const value of ordinary) {
    assert.strictEqual(couldBeDailyQuotaAssistantMessagePrefix(value), false, value);
  }
});

test('non-streaming HTTP-200 quota assistant response normalizes to 429 and keeps routed account id', async () => {
  const completionId = 'quota-nonstream-completion';
  const accountId = 'quota-nonstream-account';
  registerTestStream(completionId, accountId);

  try {
    const result = await collectNonStreamingResult(
      {} as any,
      sseStream('Você atingiu seu limite diário de chats. Tente novamente amanhã.'),
      completionId,
      'qwen3.8-max',
      'quota-nonstream-session',
      false,
      [],
    );

    assert.strictEqual(result.status, 429);
    assert.strictEqual(result.quotaLimited, true);
    assert.strictEqual(result.quotaAccountId, accountId);
    assert.strictEqual(result.body?.error?.code, 'RateLimited');
    assert.strictEqual(getStream(completionId), undefined);
  } finally {
    removeStream(completionId);
  }
});

test('streaming quota notice is withheld and replaced by retry output', async () => {
  const completionId = 'quota-stream-completion';
  const firstAccount = 'quota-stream-account-1';
  const secondAccount = 'quota-stream-account-2';
  const seenAccounts: string[] = [];

  registerTestStream(completionId, firstAccount);

  const app = new Hono();
  app.get('/', c => handleStreamingResponse(c, {
    stream: sseStream("You've reached today's chat limit. Try again tomorrow."),
    completionId,
    model: 'qwen3.8-max',
    uiSessionId: 'quota-stream-session',
    hasTools: false,
    tools: [],
    finalPrompt: 'test prompt',
    onDailyQuota: async accountId => {
      seenAccounts.push(accountId);
      registerTestStream(completionId, secondAccount);
      return {
        stream: sseStream('Normal answer after account rotation.'),
        uiSessionId: 'quota-stream-retry-session',
      };
    },
  }));

  try {
    const response = await app.request('/');
    assert.strictEqual(response.status, 200);
    const body = await response.text();

    assert.deepStrictEqual(seenAccounts, [firstAccount]);
    assert.ok(body.includes('Normal answer after account rotation.'));
    assert.ok(!body.includes("You've reached today's chat limit."));
    assert.ok(!body.includes('rate_limit_error'));
  } finally {
    removeStream(completionId);
  }
});
