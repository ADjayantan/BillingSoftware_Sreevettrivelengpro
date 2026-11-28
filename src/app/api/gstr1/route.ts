import { z } from 'zod';
import { query, route } from '@/lib/api/http';
import { getCompany } from '@/lib/data';
import { buildGstr1Report, toGstr1AuditorCsv, toGstr1PortalJson } from '@/lib/gstr1';
import { istDate } from '@/lib/india';
import { readMonth } from '@/lib/month-data';

const askSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month looks like 2026-11')
    .optional(),
  format: z.enum(['report', 'json', 'csv']).default('report'),
});

export const GET = route(async ({ request, supabase }) => {
  const ask = query(request, askSchema);
  const ym = ask.month ?? istDate(new Date()).slice(0, 7);
  const [monthData, company] = await Promise.all([readMonth(supabase, `${ym}-01`), getCompany(supabase)]);
  const report = buildGstr1Report(monthData, company?.gstin ?? null);

  if (ask.format === 'json') {
    const portalJson = JSON.stringify(toGstr1PortalJson(report), null, 2);
    const fileName = `GSTR1_${company?.gstin ?? 'STUDFLOW'}_${report.fp}.json`;
    return new Response(portalJson, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'no-store',
      },
    });
  }

  if (ask.format === 'csv') {
    const csv = toGstr1AuditorCsv(report);
    const fileName = `GSTR1_Auditor_Summary_${report.month}.csv`;
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'no-store',
      },
    });
  }

  return report;
});
