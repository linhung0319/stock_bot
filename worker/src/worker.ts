// Cloudflare 的進入點：只匯出處理函式。
// 路由與排程都在 index.ts；那個檔另外匯出常數與函式給測試用（VERSION、INGEST_CRON、handle、ingest），
// 本機的執行環境（wrangler dev）不接受進入點有處理函式以外的匯出，所以隔一層。
export { default } from './index';
