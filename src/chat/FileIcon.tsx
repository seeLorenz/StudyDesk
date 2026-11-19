export function FileIcon({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 16 16" className="file-icon" aria-hidden="true">
      <path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      {kind === "pdf" && <path d="M6 9.5h4M6 11.5h4" stroke="currentColor" strokeWidth="1.2" />}
    </svg>
  );
}
