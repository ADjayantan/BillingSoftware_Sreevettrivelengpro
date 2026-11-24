import { Field } from '@/components/field';

export interface Transport {
  transport_mode: string;
  vehicle_no: string;
  driver_name: string;
  driver_phone: string;
  lr_number: string;
  delivery_address: string;
  status: string;
}

export const MODES = [
  ['own_vehicle', 'Own vehicle'], ['transporter', 'Transporter'], ['courier', 'Courier'], ['customer_pickup', 'Customer pickup'], ['hand_delivery', 'Hand delivery'],
] as const;
export const STATUSES = [['pending', 'Pending'], ['packed', 'Packed'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered']] as const;

/** Shared by a new bill and the dispatch panel of an issued one. */
export function TransportFields({ value, onChange }: { value: Transport; onChange: (value: Transport) => void }) {
  const set = (field: keyof Transport) => (event: { target: { value: string } }) => onChange({ ...value, [field]: event.target.value });
  return (
    <>
      <Field label="Transport">
        <select className="field" value={value.transport_mode} onChange={set('transport_mode')}>
          {MODES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </Field>
      <Field label="Vehicle number"><input className="field uppercase" maxLength={20} placeholder="TN38AB1234" value={value.vehicle_no} onChange={set('vehicle_no')} /></Field>
      <Field label="Driver name"><input className="field" maxLength={80} value={value.driver_name} onChange={set('driver_name')} /></Field>
      <Field label="Driver phone"><input className="field" type="tel" maxLength={20} value={value.driver_phone} onChange={set('driver_phone')} /></Field>
      <Field label="LR number"><input className="field" maxLength={40} value={value.lr_number} onChange={set('lr_number')} /></Field>
      <Field label="Dispatch status">
        <select className="field" value={value.status} onChange={set('status')}>
          {STATUSES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </Field>
      <Field label="Deliver to, if different" className="sm:col-span-2"><input className="field" maxLength={500} value={value.delivery_address} onChange={set('delivery_address')} /></Field>
    </>
  );
}
