import { expect, test } from 'bun:test';
import { providerErrorCode, providerReasonText, providerRetryHintMs, usageLimitResetsAt } from '../src/runtime';

const claudeUsageLimit = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CZfixture0000000000000"} retry-after-ms=10920000';

test('provider errors expose only fixed classifications and HTTP status', () => {
  expect(providerErrorCode({ errorStatus: 401, errorMessage: 'secret bearer credential' })).toBe('provider_http_401');
  expect(providerErrorCode({ errorMessage: 'Model private-model not supported for this account' })).toBe('provider_model_unavailable');
  expect(providerErrorCode({ errorMessage: 'Invalid tool schema: private schema content' })).toBe('provider_tool_schema');
  expect(providerErrorCode({ errorMessage: 'private request body and account session' })).toBe('provider_error');
  expect(providerErrorCode({ errorStatus: 200 })).toBe('provider_error');
});

test('rate limits reported without an HTTP status are still classified', () => {
  expect(providerErrorCode({ errorMessage: 'Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)' })).toBe('provider_http_429');
  expect(providerErrorCode({ errorMessage: 'Rate limit reached for requests' })).toBe('provider_http_429');
  expect(providerErrorCode({ errorMessage: 'Overloaded' })).toBe('provider_http_503');
  expect(providerErrorCode({ errorStatus: 500, errorMessage: 'rate limit' })).toBe('provider_http_500');
});

test('the provider reason keeps one line for the host to clean', () => {
  expect(providerReasonText('Codex is at capacity\nstack trace')).toBe('Codex is at capacity');
  expect(providerReasonText('   ')).toBeUndefined();
  expect(providerReasonText(undefined)).toBeUndefined();
  expect(providerReasonText('x'.repeat(5000))?.length).toBe(2000);
});

test('a Claude account usage limit reads as the provider message and resets after the hint', () => {
  const now = 1_794_870_120_000;
  expect(providerErrorCode({ errorStatus: 429, errorMessage: claudeUsageLimit })).toBe('provider_usage_limit');
  expect(providerErrorCode({ errorMessage: claudeUsageLimit })).toBe('provider_usage_limit');
  expect(providerReasonText(claudeUsageLimit)).toBe("This request would exceed your account's rate limit. Please try again later. (rate_limit_error)");
  expect(providerRetryHintMs(claudeUsageLimit)).toBe(10_920_000);
  expect(usageLimitResetsAt(claudeUsageLimit, now)).toBe(now + 10_920_000);
});

test('a ChatGPT usage limit without a hint has no reset time', () => {
  const message = 'You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.';
  expect(providerErrorCode({ errorStatus: 429, errorMessage: message })).toBe('provider_usage_limit');
  expect(providerReasonText(message)).toBe(message);
  expect(usageLimitResetsAt(message)).toBeUndefined();
});

test('short throttles stay retryable rate limits', () => {
  const perMinute = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit of 50 requests per minute."}} retry-after-ms=2000';
  expect(providerErrorCode({ errorStatus: 429, errorMessage: perMinute })).toBe('provider_http_429');
  expect(providerReasonText(perMinute)).toBe("This request would exceed your account's rate limit of 50 requests per minute. (rate_limit_error)");
  expect(providerReasonText('Rate limit reached for requests per minute retry-after-ms=2000')).toBe('Rate limit reached for requests per minute');
  expect(providerErrorCode({ errorStatus: 429, errorMessage: 'Rate limit reached for requests retry-after-ms=2000' })).toBe('provider_http_429');
  expect(providerErrorCode({ errorStatus: 429, errorMessage: 'You exceeded your current quota, please check your plan and billing details.' })).toBe('provider_http_429');
  expect(providerErrorCode({ errorMessage: 'Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)' })).toBe('provider_http_429');
  expect(usageLimitResetsAt('Rate limit reached retry-after-ms=0')).toBeUndefined();
  expect(usageLimitResetsAt(`Usage limit retry-after-ms=${32 * 24 * 60 * 60_000}`)).toBeUndefined();
});

test('a server error is never a usage limit', () => {
  expect(providerErrorCode({ errorStatus: 500, errorMessage: claudeUsageLimit })).toBe('provider_http_500');
  expect(providerErrorCode({ errorStatus: 500, errorMessage: 'You have hit your usage limit.' })).toBe('provider_http_500');
});

test('text with braces that is not a JSON error body stays as written', () => {
  expect(providerReasonText('Invalid value for {temperature} in request')).toBe('Invalid value for {temperature} in request');
  expect(providerReasonText('400 {"code":"model_not_found"}')).toBe('400 {"code":"model_not_found"}');
  expect(providerReasonText('500 {"error":"Upstream failed","request_id":"req_1"}')).toBe('Upstream failed');
  expect(providerReasonText('404 {"error":{"message":"The model does not exist.","type":"invalid_request_error","code":"model_not_found"}}'))
    .toBe('The model does not exist. (code=model_not_found)');
});
