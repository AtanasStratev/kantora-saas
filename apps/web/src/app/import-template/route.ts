import { getAppContext } from '@/lib/context';
import { importTemplateXlsx } from '@/lib/import/template';

/** The empty import template (ADR-0017). Signed-in users only, like every page. */
export async function GET() {
  await getAppContext();
  return new Response(importTemplateXlsx() as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="kantora-shablon-vnos.xlsx"; filename*=UTF-8''${encodeURIComponent('Кантора-шаблон-внос.xlsx')}`,
      'Cache-Control': 'no-store',
    },
  });
}
