export default function AppLoading() {
  return (
    <div role="status" aria-label="Loading page" className="grid animate-pulse gap-5 py-1">
      <div className="h-8 w-44 rounded-[3px] bg-line" />
      <div className="h-px bg-line" />
      <div className="grid gap-3">
        <div className="h-14 rounded-[3px] border border-line bg-sunken" />
        <div className="h-14 rounded-[3px] border border-line bg-card" />
        <div className="h-14 rounded-[3px] border border-line bg-card" />
      </div>
    </div>
  );
}
