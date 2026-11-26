import { PageHead } from '@/components/page-head';
import { goodsToSend } from '@/lib/data';
import { createClient } from '@/lib/supabase/server';
import { GoodsList } from './goods-list';

export default async function DispatchPage() {
  const rows = await goodsToSend(await createClient());
  const waiting = rows.filter((row) => row.status !== 'dispatched').length;
  return (
    <>
      <PageHead title="Send goods" note={rows.length === 0 ? 'All goods are delivered.' : `${waiting} waiting · ${rows.length - waiting} on the way`} />
      <GoodsList rows={rows} />
    </>
  );
}
