import { BillingScreen } from './screen';

/** Static on purpose, with no data in it: this is the shell that opens during an outage. */
export const dynamic = 'error';

export default function BillingPage() {
  return (
    <>
      <h1 className="sr-only">New bill</h1>
      <BillingScreen />
    </>
  );
}
