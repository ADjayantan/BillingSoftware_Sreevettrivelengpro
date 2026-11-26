/** The ways money comes in, in words. Pure. */
export const PAY_WAYS = [['upi', 'UPI'], ['cash', 'Cash'], ['bank_transfer', 'Bank'], ['cheque', 'Cheque'], ['tds', 'TDS'], ['other', 'Other']] as const;
export type PayWay = (typeof PAY_WAYS)[number][0];

export const payWay = (mode: string): string => PAY_WAYS.find(([key]) => key === mode)?.[1] ?? mode;
