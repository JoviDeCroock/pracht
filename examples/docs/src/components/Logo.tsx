/** The pracht mark, the same path as `public/favicon.svg`. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      class="logo-mark"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="pracht-logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#a78bfa" />
          <stop offset="100%" stop-color="#7c3aed" />
        </linearGradient>
      </defs>
      <path
        fill="url(#pracht-logo-gradient)"
        fill-rule="evenodd"
        d="M 5 4 L 12 4 A 8 8 0 1 1 12 20 L 12 28 L 5 28 Z M 17 12 A 3 3 0 1 0 23 12 A 3 3 0 1 0 17 12 Z"
      />
      <circle cx="23" cy="8" r="1.1" fill="#fbbf24" />
    </svg>
  );
}
