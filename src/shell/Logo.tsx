import logo from "../assets/logo.png";

// StudyDesk's mark: the SD planet, with its black background made transparent
// (scripts/make-logo.py makes the file from the full artwork).
export function Logo({ className = "brand-mark" }: { className?: string }) {
  return <img className={className} src={logo} alt="" aria-hidden="true" draggable={false} />;
}
