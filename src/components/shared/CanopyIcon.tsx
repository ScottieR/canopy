export function CanopyIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="ci-bg" x1="32" y1="0" x2="32" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0F1A15" />
          <stop offset="1" stopColor="#172B22" />
        </linearGradient>
        <linearGradient id="ci-leaf" x1="20" y1="10" x2="44" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34D399" />
          <stop offset="1" stopColor="#059669" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#ci-bg)" />
      <path d="M32 48V30" stroke="#6EE7B7" strokeWidth="2.5" strokeLinecap="round" />
      <path
        d="M32 30C32 30 18 26 14 18C18 14 25 12 32 16C39 12 46 14 50 18C46 26 32 30 32 30Z"
        fill="url(#ci-leaf)"
        opacity="0.9"
      />
      <path
        d="M32 26C32 26 22 23 19 17C22 15 27 14 32 17C37 14 42 15 45 17C42 23 32 26 32 26Z"
        fill="#6EE7B7"
        opacity="0.5"
      />
      {/* Agent dots sheltering beneath the canopy */}
      <circle cx="26" cy="42" r="2" fill="#34D399" opacity="0.4" />
      <circle cx="38" cy="44" r="1.5" fill="#34D399" opacity="0.3" />
      <circle cx="31" cy="40" r="1" fill="#6EE7B7" opacity="0.35" />
    </svg>
  );
}
