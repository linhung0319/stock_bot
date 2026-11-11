import { describe, expect, it } from 'vitest';
import { VERSION, handle } from '../src/index';

describe('專案骨架', () => {
  it('/health 回傳版本', async () => {
    const res = await handle(new Request('https://example.com/health'), {} as never);
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });
});
