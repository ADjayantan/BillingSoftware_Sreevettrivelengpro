import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'StudFlow AI',
  description: 'Crash-proof billing and dispatch for stud threading and job work',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'StudFlow' },
  icons: { icon: '/icon-192.png', apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ffffff' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
