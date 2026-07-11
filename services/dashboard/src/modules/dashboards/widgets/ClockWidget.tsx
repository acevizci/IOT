import { useState, useEffect } from "react";

export function ClockWidget({ title }: { config: Record<string, any>; title?: string | null }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="h-full flex flex-col items-center justify-center">
      {title && <p className="text-xs text-text-secondary mb-1">{title}</p>}
      <p className="text-2xl font-semibold tabular-nums">{now.toLocaleTimeString("tr-TR")}</p>
      <p className="text-xs text-text-muted">{now.toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" })}</p>
    </div>
  );
}
