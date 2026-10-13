export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="empty-state">{children}</div>
    </div>
  );
}
