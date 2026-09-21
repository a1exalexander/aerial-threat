import type { ReactNode } from 'react';

// Hand-drawn 24×24 stroke icons. Always decorative: every icon sits next to a text label.
const ICONS = {
  siren: (
    <>
      <path d="M7 18v-5a5 5 0 0 1 10 0v5" />
      <path d="M4 18h16v3H4z" />
      <path d="M12 2v2M4.9 4.9l1.4 1.4M19.1 4.9l-1.4 1.4M2 12h2M20 12h2" />
      <path d="M10 13a2 2 0 0 1 2-2" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.5-2.7 4M12 17.5h.01" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" />
    </>
  ),
  arrow: <path d="M3 11 21 3l-8 18-2-8z" />,
  stack: <path d="m12 3 9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5" />,
  burst: <path d="m12 2 2.2 5.4L20 6l-2.4 5.3L22 15l-5.7.6L16 21.5l-4-3.8-4 3.8-.3-5.9L2 15l4.4-3.7L4 6l5.8 1.4z" />,
  radar: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 12 18.5 5.5M12 6.5a5.5 5.5 0 1 0 5.5 5.5" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="12" cy="10" r="1.5" />
      <path d="M12 11.5V22M8.5 6.5a5 5 0 0 0 0 7M15.5 6.5a5 5 0 0 1 0 7M5.6 3.6a9 9 0 0 0 0 12.8M18.4 3.6a9 9 0 0 1 0 12.8" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21.5s-7-6-7-11.5a7 7 0 0 1 14 0c0 5.5-7 11.5-7 11.5z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  water: <path d="M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 16c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" />,
  reply: <path d="M9 15 4 10l5-5M4 10h9a7 7 0 0 1 7 7v2" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  offline: (
    <path d="m2 2 20 20M8.5 16.4a5 5 0 0 1 6.2-.7M5 12.9a10 10 0 0 1 4.3-2.6M19 12.9a10 10 0 0 0-2.5-1.9M1.5 8.8a15 15 0 0 1 4-2.6M22.5 8.8A15 15 0 0 0 10.6 5M12 20h.01" />
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      data-icon={name}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
