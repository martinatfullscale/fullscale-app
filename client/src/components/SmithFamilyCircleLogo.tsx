/**
 * Smith Family Circle logo — renders the uploaded PNG inverted to white.
 * The CSS filter `invert(1) brightness(2)` turns the black logo white.
 *
 * Logo file: attached_assets/logo-smith-family-circle.png
 */
import logoSrc from "@assets/logo-smith-family-circle.png";

export function SmithFamilyCircleLogo({ className = "h-10 w-auto" }: { className?: string }) {
  return (
    <img
      src={logoSrc}
      alt="Smith Family Circle"
      className={className}
      style={{ filter: "invert(1) brightness(2)" }}
      loading="lazy"
    />
  );
}
