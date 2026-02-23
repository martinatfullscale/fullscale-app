/**
 * Smith Family Circle logo — white PNG on transparent background.
 * Logo file: attached_assets/logo-smith-family-circle.png
 */
import logoSrc from "@assets/logo-smith-family-circle.png";

export function SmithFamilyCircleLogo({ className = "h-10 w-auto" }: { className?: string }) {
  return (
    <img
      src={logoSrc}
      alt="Smith Family Circle"
      className={className}
      loading="lazy"
    />
  );
}
