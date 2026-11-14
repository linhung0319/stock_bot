// T7：每日與每月流程、LINE 推播、缺席告警。
// 對外請求全部用假的 fetcher（成分股是真實固定檔，價格是假的，LINE 也是假的），D1 用本機模擬器。
// 時間軸：2026-11-19 建立帳戶 → 11-20、11-23、11-24（NVDA 暴跌）、11-25、11-27（感恩節隔天）→ 11-30 月底出 12 月月報。
import { describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { MAX_CATCHUP, getFlowState, monthlyMade, runFlow, sessionsToProcess, type Attempt } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL, notifText } from '../src/app/line';
import { realBackend } from '../src/app/site/backend';
import { buildMarketView } from '../src/data/marketView';
import { loadRanking, loadSeries, recentAlerts } from '../src/data/store';
import { applySnapshot, bookShares, classify, createAccount, dailyCheck, monthlyReport, resumeMonthly, type Account } from '../src/engine';
import { FINAL_CRON, INGEST_CRON, handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

interface Line {
  sent: { to: string; text: string }[];
  /** 接下來幾次 LINE 回 500。 */
  failNext: number;
}

function fetcherOf(w: World, line: Line): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      if (line.failNext > 0) {
        line.failNext--;
        return new Response('{"message":"server error"}', { status: 500 });
      }
      const b = JSON.parse(String(init?.body)) as { to: string; messages: { text: string }[] };
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer line-token');
      line.sent.push({ to: b.to, text: b.messages[0].text });
      return Response.json({});
    }
    return base(url, init);
  };
}

const envOf = (db: D1Database, line = true): Env => ({ DB: db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', ...(line ? { LINE_CHANNEL_TOKEN: 'line-token', LINE_USER_ID: 'U123' } : {}) });
/** 再試一次的排程時間：隔天 UTC 01:30。 */
const finalTime = (date: string) => new Date(new Date(date + 'T23:30:00Z').getTime() + 2 * 3600_000);

interface Ctx {
  db: D1Database;
  w: World;
  line: Line;
  env: Env;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { line?: boolean; createOn?: string; paper?: boolean; extra?: (a: Account) => Account } = {}): Promise<void> {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld(opt.createOn ?? '2026-11-19');
    const line: Line = { sent: [], failNext: 0 };
    const env = envOf(db, opt.line !== false);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcherOf(w, line), { now: attempt === 'FINAL' ? finalTime(date) : cronTime(date), attempt });
    };
    // 還沒有帳戶：流程只抓資料
    const r0 = await run(opt.createOn ?? '2026-11-19');
    expect(r0.status).toBe('NO_ACCOUNT');
    await createTestAccount(db, opt.createOn ?? '2026-11-19', opt.paper ?? true, opt.extra);
    await fn({ db, w, line, env, run });
  } finally {
    await d.dispose();
  }
}

/** 帳戶：核心 VOO、自選 NVDA（約 20%）與 MSFT、現金一些；動能桶是空的（月報會買進前 5 名）。 */
async function createTestAccount(db: D1Database, date: string, paper: boolean, extra?: (a: Account) => Account): Promise<void> {
  const series = await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MSFT']);
  const { view } = buildMarketView(series, date, 'VOO');
  const px = (t: string) => view.close[t][view.i];
  const total = 200_000;
  let acct = createAccount(
    {
      paper,
      cash: 10_000,
      core: { VOO: Math.floor((0.62 * total) / px('VOO')) },
      own: {
        NVDA: { shares: Math.floor((0.2 * total) / px('NVDA')), stdWeight: 0.1 },
        MSFT: { shares: Math.floor((0.08 * total) / px('MSFT')), stdWeight: 0.05 },
      },
    },
    view,
  );
  if (extra) acct = extra(acct);
  await saveAccount(db, acct, null, '建立帳戶', new Date(date + 'T12:00:00Z'));
}

const acctOf = async (db: D1Database) => (await loadAccount(db))!.acct;
const notifOf = (a: Account, id: number) => a.notifs.find((n) => n.id === id)!;

describe('平常的日子', () => {
  it('收盤後處理一次；兩小時後的再試不會重做；假日不做；沒有通知就不推播', async () => {
    await withWorld(async ({ db, line, run }) => {
      const r1 = await run('2026-11-20');
      expect(r1).toMatchObject({ session: '2026-11-20', status: 'DONE', processed: ['2026-11-20'], created: [], monthly: null });
      expect(await getFlowState(db, 'lastSession')).toBe('2026-11-20');
      const rev1 = (await loadAccount(db))!.rev;

      const r2 = await run('2026-11-20', 'FINAL');
      expect(r2).toMatchObject({ status: 'SKIPPED', processed: [] });
      expect((await loadAccount(db))!.rev).toBe(rev1);

      // 感恩節（11-26）：訊號日還是 11-25，已經做過
      await run('2026-11-23');
      await run('2026-11-24');
      await run('2026-11-25');
      const thanks = await runFlow(envOf(db), fetcherOf(newWorld('2026-11-25'), line), { now: cronTime('2026-11-26'), attempt: 'FIRST' });
      expect(thanks).toMatchObject({ session: '2026-11-25', status: 'SKIPPED' });
      expect(line.sent).toEqual([]);
      expect(await getFlowState(db, 'lastSession')).toBe('2026-11-25');
    });
  });

  it('慢規則每天只前進一步：和直接呼叫引擎逐日跑的結果相同', async () => {
    await withWorld(async ({ db, run }) => {
      const start = await acctOf(db);
      for (const day of ['2026-11-20', '2026-11-23', '2026-11-24']) await run(day);
      const series = await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MSFT']);
      let direct = start;
      for (const day of ['2026-11-20', '2026-11-23', '2026-11-24']) direct = dailyCheck(direct, buildMarketView(series, day, 'VOO').view).acct;
      const after = await acctOf(db);
      expect(after.own.NVDA.slow).toEqual(direct.own.NVDA.slow);
      expect(after.own.MSFT.slow).toEqual(direct.own.MSFT.slow);
      expect(after.rule).toEqual(direct.rule);
    });
  });
});

describe('當天通知', () => {
  it('自選股暴跌、減半的變動 ≥ 總資產 5% → 當天通知、寫好理由、LINE 附股數與連結', async () => {
    await withWorld(async ({ db, w, line, run }) => {
      await run('2026-11-20');
      await run('2026-11-23');
      w.shock.NVDA = { from: '2026-11-24', factor: 0.7 };
      const r = await run('2026-11-24');
      expect(r.status).toBe('DONE');
      expect(r.created).toHaveLength(1);
      const acct = await acctOf(db);
      const n = notifOf(acct, r.created[0]);
      expect(n).toMatchObject({ kind: 'URGENT', title: 'NVDA 慢規則減半', date: '2026-11-24', status: 'PENDING' });
      // 理由在產生的當下寫好（網站的 annotate）
      expect(n.items.every((it) => 'x' in it && it.x)).toBe(true);
      const sell = n.preview!.merged.find((m) => m.ticker === 'NVDA')!;
      expect(sell.shares).toBeLessThan(0);

      expect(line.sent).toHaveLength(1);
      expect(line.sent[0].to).toBe('U123');
      const text = line.sent[0].text;
      expect(text.split('\n')[0]).toBe('【紙上】【當天】NVDA 慢規則減半');
      expect(text).toContain(`賣 NVDA ${-sell.shares} 股 · 自選訊號`);
      expect(text).toContain(`https://bot.example/#/n/${n.id}`);
      expect(text).toBe(notifText(acct, n, `https://bot.example/#/n/${n.id}`));

      // 兩個交易日沒有回報 → 提醒（也推播）
      w.shock.NVDA = { from: '2026-11-24', factor: 0.7 };
      await run('2026-11-25');
      const r3 = await run('2026-11-27');
      const a3 = await acctOf(db);
      const remind = r3.created.map((id) => notifOf(a3, id)).find((x) => x.ref === n.id)!;
      expect(remind.kind).toBe('INFO');
      expect(line.sent.at(-1)!.text.split('\n')[0]).toBe(`【紙上】【提醒】提醒：通知 #${n.id}（2026-11-24）還沒回報`);
    });
  });
});

describe('月報', () => {
  it('月底收盤後出下個月的月報：用當天的排名、同公司的對照；和直接呼叫引擎相同；LINE 推一則', async () => {
    await withWorld(
      async ({ db, line, run }) => {
        for (const day of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(day);
        const before = await acctOf(db);
        const r = await run('2026-11-30');
        expect(r).toMatchObject({ status: 'DONE', processed: ['2026-11-30'] });
        expect(r.monthly).not.toBeNull();
        const acct = await acctOf(db);
        const n = notifOf(acct, r.monthly!);
        expect(n).toMatchObject({ kind: 'MONTHLY', title: '2026-12 月報', date: '2026-11-30' });
        const ranking = (await loadRanking(db, '2026-11-30'))!;
        expect(n.monthly!.input.order).toEqual(ranking.order);
        expect(n.monthly!.input.company).toEqual(ranking.detail.company);
        expect(n.items.every((it) => 'x' in it && it.x)).toBe(true);

        // 直接呼叫引擎：每日檢查 → 月報
        const series = await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MSFT', ...ranking.order]);
        const view = buildMarketView(series, '2026-11-30', 'VOO').view;
        const direct = monthlyReport(dailyCheck(before, view).acct, view, { order: ranking.order, month: '2026-12', company: ranking.detail.company });
        expect(n.items.map((i) => [i.title, i.choices.map((c) => c.lines)])).toEqual(direct.notif.items.map((i) => [i.title, i.choices.map((c) => c.lines)]));
        expect(n.preview).toEqual(direct.notif.preview);
        expect(acct.rule).toEqual(direct.acct.rule);
        // 動能桶原本是空的：買進前 5 名
        expect(acct.rule.heldMom).toHaveLength(5);

        expect(line.sent).toHaveLength(1);
        const text = line.sent[0].text;
        expect(text.split('\n')[0]).toBe('【月報】2026-12 月報');
        for (const t of acct.rule.heldMom) expect(text).toMatch(new RegExp(`買 ${t} \\d+ 股 · 動能換股`));
        expect(text).toContain(`https://bot.example/#/n/${n.id}`);
        expect(monthlyMade(acct, '2026-12')).toBe(true);

        // 同一天再跑：不會再出一份
        const again = await run('2026-11-30', 'FINAL');
        expect(again.status).toBe('SKIPPED');
        expect((await acctOf(db)).notifs.filter((x) => x.kind === 'MONTHLY')).toHaveLength(1);
      },
      { paper: false },
    );
  });

  it('月底成分股名單不一致 → 月報照出，但暫停換股（動能名單不變）並告警', async () => {
    await withWorld(async ({ db, w, line, run }) => {
      await run('2026-11-27');
      w.wikiText = w.wikiText.replace('|MMM}}', '|ZZZZ}}');
      const r = await run('2026-11-30');
      expect(r.status).toBe('DONE');
      expect(r.alerts).toEqual(['MONTHLY_PAUSED']);
      const acct = await acctOf(db);
      const n = notifOf(acct, r.monthly!);
      expect(n.monthly!.input.paused).toBe('SPY 持股檔和 Wikipedia 的成分股名單不一致');
      expect(n.text).toContain('本月暫停換股');
      expect(acct.rule.heldMom).toEqual([]);
      // 通知一則＋告警一則（成分股不一致、暫停換股合在一起）
      expect(line.sent).toHaveLength(2);
      expect(line.sent[1].text).toContain('【告警】');
      expect(line.sent[1].text).toContain('只在 SPY 持股檔：MMM');
      expect(line.sent[1].text).toContain('本月暫停換股');
      expect(((await recentAlerts(db)) as { sent_at: string | null }[]).every((a) => a.sent_at)).toBe(true);
      // 網站的警示列也看得到
      const site = await realBackend(envOf(db), fetcherOf(w, line), cronTime('2026-11-30')).load();
      expect(site.warnings.some((x) => x.includes('本月暫停換股'))).toBe(true);
      expect(site.warnings.some((x) => x.includes('只在 SPY 持股檔：MMM'))).toBe(true);
    });
  });

  it('有未分類的變動 → 月報暫停並留下訊號日的排名；分類之後用那份排名重算', async () => {
    await withWorld(
      async ({ db, run }) => {
        await run('2026-11-27');
        const r = await run('2026-11-30');
        const acct = await acctOf(db);
        const blocked = notifOf(acct, r.monthly!);
        expect(blocked).toMatchObject({ kind: 'INFO', title: '月報暫停：有未分類的持股變動' });
        const ranking = (await loadRanking(db, '2026-11-30'))!;
        expect(blocked.monthly!.input).toMatchObject({ month: '2026-12', order: ranking.order });

        // 隔天使用者分類（價格是 12-01 的）
        await run('2026-12-01');
        const a2 = await acctOf(db);
        const series = await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MSFT', 'AAPL', ...ranking.order]);
        const view = buildMarketView(series, '2026-12-01', 'VOO').view;
        const cls = a2.notifs.find((x) => x.kind === 'CLASSIFY')!;
        const out = classify(a2, view, cls.id, { bucket: 'own' });
        expect(out.monthlyUnblocked).toBe(true);
        const m = resumeMonthly(out.acct, view);
        expect(m.notif).toMatchObject({ kind: 'MONTHLY', title: '2026-12 月報' });
        expect(m.notif!.monthly!.input.order).toEqual(ranking.order);
        expect(m.acct.notifs.find((x) => x.id === blocked.id)!.status).toBe('READ');
      },
      {
        // 建立帳戶之後填了一份快照，多出 3 股 AAPL（清單外的變動，還沒分類）
        extra: (a) => {
          const v = { date: '2026-11-19', i: 0, close: { AAPL: [200], VOO: [1], NVDA: [1], MSFT: [1], SGOV: [1] } };
          return applySnapshot(a, v, { shares: { ...bookShares(a), AAPL: 3 }, cash: a.cash - 600 }).acct;
        },
      },
    );
  });
});

describe('資料失敗與缺席告警', () => {
  it('第一次失敗不推播；再試還是失敗 → 推一則告警；隔天照順序補做漏掉的那天', async () => {
    await withWorld(async ({ db, w, line, run }) => {
      w.fail.add('VOO');
      const r1 = await run('2026-11-20');
      expect(r1.status).toBe('NO_SIGNAL');
      expect(line.sent).toEqual([]);
      const r2 = await run('2026-11-20', 'FINAL');
      expect(r2.status).toBe('NO_SIGNAL');
      expect(r2.alerts).toContain('FLOW_MISSED');
      expect(line.sent).toHaveLength(1);
      expect(line.sent[0].text).toContain('【告警】');
      expect(line.sent[0].text).toContain('抓不到價格，今天不產生訊號：VOO');
      expect(line.sent[0].text).toContain('流程沒有跑完');

      w.fail.clear();
      const r3 = await run('2026-11-23');
      expect(r3).toMatchObject({ status: 'DONE', processed: ['2026-11-20', '2026-11-23'] });
      expect(await getFlowState(db, 'lastSession')).toBe('2026-11-23');
      expect(line.sent).toHaveLength(1);
    });
  });

  it('第一次失敗、再試成功 → 那次的告警標成已解決，不推播', async () => {
    await withWorld(async ({ db, w, line, run }) => {
      w.fail.add('NVDA');
      expect((await run('2026-11-20')).status).toBe('NO_SIGNAL');
      w.fail.clear();
      expect((await run('2026-11-20', 'FINAL')).status).toBe('DONE');
      expect(line.sent).toEqual([]);
      const alerts = (await recentAlerts(db)) as { kind: string; sent_at: string | null }[];
      expect(alerts.find((a) => a.kind === 'PRICE_MISSING')!.sent_at).toBe('RESOLVED');
    });
  });

  it('LINE 推播失敗 → 記下來，下一次流程再推', async () => {
    await withWorld(async ({ db, w, line, run }) => {
      await run('2026-11-23');
      w.shock.NVDA = { from: '2026-11-24', factor: 0.7 };
      line.failNext = 1;
      const r = await run('2026-11-24');
      expect(r.push).toMatchObject({ configured: true, sent: 0, failed: 1 });
      expect(line.sent).toEqual([]);
      const r2 = await run('2026-11-24', 'FINAL');
      expect(r2.status).toBe('SKIPPED');
      expect(r2.push).toMatchObject({ sent: 1, failed: 0 });
      expect(line.sent[0].text).toContain('NVDA 慢規則減半');
      // 推成功之後不再推
      await run('2026-11-25');
      expect(line.sent.filter((s) => s.text.includes('【當天】NVDA'))).toHaveLength(1);
      const rows = (await db.prepare('SELECT kind, ref, ok FROM pushes ORDER BY id').all()).results;
      expect(rows).toEqual([
        { kind: 'NOTIF', ref: r.created[0], ok: 0 },
        { kind: 'NOTIF', ref: r.created[0], ok: 1 },
      ]);
    });
  });

  it('漏掉太多天 → 只做今天並告警', async () => {
    await withWorld(async ({ db, line, run }) => {
      await db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('lastSession', '2026-10-01', 'x')").run();
      const r = await run('2026-11-20');
      expect(r).toMatchObject({ status: 'DONE', processed: ['2026-11-20'], alerts: ['FLOW_GAP'] });
      expect(line.sent[0].text).toContain('漏了');
    });
  });

  it('LINE 還沒設定：流程照跑，只是不推播', async () => {
    await withWorld(
      async ({ db, w, line, run }) => {
        w.shock.NVDA = { from: '2026-11-20', factor: 0.7 };
        const r = await run('2026-11-20');
        expect(r.status).toBe('DONE');
        expect(r.created).toHaveLength(1);
        expect(r.push).toEqual({ configured: false, sent: 0, failed: 0, errors: [] });
        expect(line.sent).toEqual([]);
        expect((await db.prepare('SELECT COUNT(*) AS n FROM pushes').first<{ n: number }>())!.n).toBe(0);
      },
      { line: false },
    );
  });
});

describe('要處理哪幾天', () => {
  it('上次之後的每個交易日（跳過週末與假日）；超過上限只做今天', () => {
    expect(sessionsToProcess('2026-11-24', '2026-11-30', {})).toEqual({ sessions: ['2026-11-25', '2026-11-27', '2026-11-30'], gap: 0 });
    expect(sessionsToProcess('2026-11-30', '2026-11-30', {})).toEqual({ sessions: [], gap: 0 });
    expect(sessionsToProcess(null, '2026-11-30', {})).toEqual({ sessions: ['2026-11-30'], gap: 0 });
    const far = sessionsToProcess('2026-10-01', '2026-11-30', {});
    expect(far.sessions).toEqual(['2026-11-30']);
    expect(far.gap).toBeGreaterThan(MAX_CATCHUP);
  });
});

describe('端點與排程', () => {
  it('/admin/flow、/admin/flow/status、/admin/line/test 要 ADMIN_TOKEN', async () => {
    await withWorld(async ({ db, w, line, env }) => {
      const f = fetcherOf(w, line);
      const req = (path: string, method = 'POST', token = 't') => new Request('https://bot.example' + path, { method, headers: { Authorization: `Bearer ${token}` } });
      expect((await handle(req('/admin/flow', 'POST', 'x'), env, f, cronTime('2026-11-19'))).status).toBe(401);
      w.dataDate = '2026-11-20';
      const r = await handle(req('/admin/flow'), env, f, cronTime('2026-11-20'));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ attempt: 'MANUAL', status: 'DONE', processed: ['2026-11-20'] });
      const st = (await (await handle(req('/admin/flow/status', 'GET'), env, f, cronTime('2026-11-20'))).json()) as { lastSession: string; line: boolean; runs: { attempt: string }[] };
      expect(st).toMatchObject({ lastSession: '2026-11-20', line: true });
      expect(st.runs[0].attempt).toBe('MANUAL');
      const t = await handle(req('/admin/line/test'), env, f, cronTime('2026-11-20'));
      expect(t.status).toBe(200);
      expect(line.sent.at(-1)!.text).toContain('測試訊息');
      const a = await handle(req('/admin/alert/test'), env, f, cronTime('2026-11-20'));
      expect(a.status).toBe(200);
      expect(line.sent.at(-1)!.text).toBe('【紙上】【告警】stock bot\n・這是測試告警：收到表示告警的推播可以用。\n\nhttps://bot.example/');
      void db;
    });
  });

  it('兩個排程都寫在 wrangler 設定裡；網站網址設成 vars', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const cfg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc'), 'utf8');
    expect(cfg).toContain(`"crons": ["${INGEST_CRON}", "${FINAL_CRON}"]`);
    expect(cfg).toContain('"SITE_URL"');
  });
});
