import { describe, expect, it } from 'vitest';
import worker, { VERSION } from '../src/index';

describe('專案骨架', () => {
  it('/health 回傳版本', async () => {
    const res = await worker.fetch(new Request("https://example.com/health"));
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });
});
