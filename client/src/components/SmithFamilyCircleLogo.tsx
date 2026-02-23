/**
 * Smith Family Circle logo — SVG rendered in white for dark backgrounds.
 * Yin-yang style circle with 5 dots along the S-curve.
 */
export function SmithFamilyCircleLogo({ className = "h-10 w-auto" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Outer circle — triple ring effect */}
      <circle cx="100" cy="100" r="92" stroke="white" strokeWidth="3" fill="none" />
      <circle cx="100" cy="100" r="87" stroke="white" strokeWidth="2" fill="none" />
      <circle cx="100" cy="100" r="82" stroke="white" strokeWidth="1.5" fill="none" />

      {/* S-curve divider (yin-yang style) */}
      <path
        d="M 100 8 C 60 8, 20 50, 50 100 C 80 150, 140 150, 150 100 C 160 50, 140 8, 100 8"
        stroke="white"
        strokeWidth="4.5"
        fill="none"
        strokeLinecap="round"
      />

      {/* 5 dots along the S-curve */}
      <circle cx="100" cy="12" r="7" fill="white" />
      <circle cx="48" cy="58" r="7" fill="white" />
      <circle cx="100" cy="100" r="7" fill="white" />
      <circle cx="152" cy="142" r="7" fill="white" />
      <circle cx="100" cy="188" r="7" fill="white" />
    </svg>
  );
}
