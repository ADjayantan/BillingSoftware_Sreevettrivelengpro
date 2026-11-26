import { Field } from '@/components/field';
import { STEP } from '@/lib/goods-steps';

export interface Transport {
  transport_mode: string;
  vehicle_no: string;
  driver_name: string;
  driver_phone: string;
  lr_number: string;
  delivery_address: string;
  status: string;
}

const MODES = [
  ['own_vehicle', 'Our vehicle'], ['transporter', 'Transporter'], ['courier', 'Courier'], ['customer_pickup', 'Customer takes it'], ['hand_delivery', 'By hand'],
] as const;

/** Shared by a new bill, an issued one and "Send goods". */
export function TransportFields({ value, onChange, withStatus = true }: { value: Transport; onChange: (value: Transport) => void; withStatus?: boolean }) {
  const set = (field: keyof Transport) => (event: { target: { value: string } }) => onChange({ ...value, [field]: event.target.value });
  return (
    <>
      <Field label="How it goes">
        <select className="field" value={value.transport_mode} onChange={set('transport_mode')}>
          {MODES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </Field>
      <Field label="Vehicle number"><input className="field uppercase" maxLength={20} placeholder="TN38AB1234" value={value.vehicle_no} onChange={set('vehicle_no')} /></Field>
      <Field label="Driver name"><input className="field" maxLength={80} value={value.driver_name} onChange={set('driver_name')} /></Field>
      <Field label="Driver phone"><input className="field" type="tel" maxLength={20} value={value.driver_phone} onChange={set('driver_phone')} /></Field>
      <Field label="LR number"><input className="field" maxLength={40} value={value.lr_number} onChange={set('lr_number')} /></Field>
      {withStatus ? (
        <Field label="Where the goods are">
          <select className="field" value={value.status} onChange={set('status')}>
            {Object.entries(STEP).map(([key, { text }]) => <option key={key} value={key}>{text}</option>)}
          </select>
        </Field>
      ) : null}
      <Field label="Deliver to, if it is another place" className="sm:col-span-2"><input className="field" maxLength={500} value={value.delivery_address} onChange={set('delivery_address')} /></Field>
    </>
  );
}
