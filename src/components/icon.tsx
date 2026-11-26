/** Line drawings, 24 × 24, in the colour of the text around them. */
const PATHS = {
  home: 'M3 11.2 12 4l9 7.2M5.5 9.6V20h4.8v-5.6h3.4V20h4.8V9.6',
  bill: 'M6 3h12v18l-2.4-1.6L13.2 21l-2.4-1.6L8.4 21 6 19.4zM9.2 8h5.6M9.2 12h5.6',
  plus: 'M12 5v14M5 12h14',
  users: 'M9 11.5a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2zM2.8 19.6c.5-3.3 2.9-5.2 6.2-5.2s5.7 1.9 6.2 5.2M16 4.6a3.5 3.5 0 0 1 0 6.7M17.6 14.8c2 .6 3.3 2.2 3.6 4.8',
  box: 'M12 3 20 7.4v9.2L12 21l-8-4.4V7.4zM4.2 7.5 12 12l7.8-4.5M12 12v9',
  work: 'M14.5 6.2a4 4 0 0 1 5.2-1.6l-2.7 2.7 1.7 1.7 2.7-2.7a4 4 0 0 1-5.4 5L8.6 18.7a2.1 2.1 0 0 1-3-3l7.3-7.3',
  sheet: 'M4 4h16v16H4zM4 9.4h16M4 14.7h16M10 9.4V20',
  trend: 'M3 17 9.2 10.8l4 4L21 7M15.5 7H21v5.5',
  building: 'M4.5 21V4.5h9V21M13.5 10h6v11M3 21h18M8 8.5h2M8 12.5h2M8 16.5h2M16.5 14h.5M16.5 17.5h.5',
  out: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9.5',
  search: 'M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6zM20 20l-4.3-4.3',
  print: 'M7 8V3.5h10V8M7 17H4V8h16v9h-3M7 13.5h10V20.5H7z',
  chat: 'M4 19.5 5.3 15.4a7.6 7.6 0 1 1 3.2 2.9z',
  truck: 'M3 6h11v10H3zM14 9.5h3.7L21 13v3h-7M7 19a1.9 1.9 0 1 0 0-3.8A1.9 1.9 0 0 0 7 19zM17 19a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z',
  wallet: 'M3.5 7.5h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5 15.5 4v3.5M16.5 13.5h.6',
  check: 'M4.5 12.8 9.7 18 19.5 6.8',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.3V12l3.2 2',
  alert: 'M12 4 2.8 20h18.4zM12 10v4.5M12 17.3v.2',
  right: 'M9 5l7 7-7 7',
  down: 'M5.5 9 12 15.5 18.5 9',
  cal: 'M4 5.5h16v15H4zM4 10h16M8.5 3v4M15.5 3v4',
  dots: 'M5.5 12h.1M12 12h.1M18.5 12h.1',
  mic: 'M12 14.5a3 3 0 0 0 3-3v-5a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM6 11.5a6 6 0 0 0 12 0M12 17.5V21',
  cloud: 'M7 18.5a4.5 4.5 0 0 1-.3-9 5.8 5.8 0 0 1 11.2 1.3A3.9 3.9 0 0 1 17.5 18.5zM9 13.5l2.2 2.2 3.8-3.9',
  menu: 'M4 7h16M4 12h16M4 17h16',
  coin: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9 8.5h6M9 11.5h6M9.5 8.5c4.5 0 4.5 5 0 5l4 3.5',
  lock: 'M6 11h12v9.5H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  wifi: 'M3 9.5a13.5 13.5 0 0 1 18 0M6.3 13a8.6 8.6 0 0 1 11.4 0M9.5 16.5a4 4 0 0 1 5 0M12 19.8v.1',
  cog: 'M4 7h8.5M18 7h2M15.2 9.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4zM4 17h2M11.5 17H20M8.8 19.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z',
  device: 'M4 5h16v11H4zM9 20h6M12 16v4',
  edit: 'M4.5 19.5l1-4L16 5l3 3L8.5 18.5zM14 7l3 3',
  drive: 'M8.5 4h7l6 10.5-3.5 5.5H6l-3.5-5.5zM8.5 4l6.5 11M15.5 4L9 15M3 15h18',
} as const;

export type IconName = keyof typeof PATHS;

/** Beside words only: it says nothing by itself. */
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true"><path d={PATHS[name]} /></svg>;
}
