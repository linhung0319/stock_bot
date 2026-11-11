// Worker 進入點。排程、網站、LINE、AI 端點在 src/app/（T6 之後加入）。
export const VERSION = '0.1.0';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, version: VERSION });
    }
    return new Response('stock bot', { status: 200 });
  },
} satisfies ExportedHandler;
