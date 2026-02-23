/**
 * Smith Family Circle logo — SVG rendered in white for dark backgrounds.
 * Yin-yang style circle with S-curve divider and 5 junction dots.
 * The S-curve connects to the outer circle at top-center and bottom-center,
 * curving left through the upper half and right through the lower half.
 */
export function SmithFamilyCircleLogo({ className = "h-10 w-auto" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Outer circle — triple concentric ring */}
      <circle cx="100" cy="100" r="95" stroke="white" strokeWidth="3.5" fill="none" />
      <circle cx="100" cy="100" r="89" stroke="white" strokeWidth="2" fill="none" />
      <circle cx="100" cy="100" r="84" stroke="white" strokeWidth="1.2" fill="none" />

      {/* S-curve: starts at top-center of circle, curves left then right, ends at bottom-center */}
      <path
        d="M 100 5
           C 55 5, 15 45, 40 100
           C 65 155, 145 155, 160 100
           C 175 45, 145 5, 100 5"
        stroke="white"
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* 5 dots: top junction, upper-left curve, center crossing, lower-right curve, bottom junction */}
      <circle cx="100" cy="5" r="8" fill="white" />
      <circle cx="38" cy="65" r="7" fill="white" />
      <circle cx="100" cy="100" r="7" fill="white" />
      <circle cx="162" cy="135" r="7" fill="white" />
      <circle cx="100" cy="195" r="8" fill="white" />
    </svg>
  );
}
