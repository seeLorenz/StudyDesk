import logo from "../assets/logo.png";

// StudyDesk's mark: the SD planet with its rings, on a transparent background.
export function Logo({ className = "brand-mark" }: { className?: string }) {
  return <img className={className} src={logo} alt="" aria-hidden="true" draggable={false} />;
}
