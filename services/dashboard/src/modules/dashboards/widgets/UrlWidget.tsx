export function UrlWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  if (!config.url) return <p className="text-xs text-text-muted p-2">Widget ayarlarından URL girin.</p>;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {title && <p className="text-xs text-text-secondary mb-1 px-1">{title}</p>}
      <iframe src={config.url} className="flex-1 w-full border-0 rounded-lg" title={title || "URL widget"} />
    </div>
  );
}
