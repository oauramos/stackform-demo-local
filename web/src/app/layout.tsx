import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Stackform Demo',
  description: 'Stackform CDK deployment demo — Lambda, Step Functions, API Gateway',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
