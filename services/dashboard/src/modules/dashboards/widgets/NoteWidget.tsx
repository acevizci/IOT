export function NoteWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {title && <p className="text-xs text-text-secondary mb-2">{title}</p>}
      <div className="flex-1 overflow-y-auto text-sm whitespace-pre-wrap text-text-secondary">
        {config.text || <span className="text-text-muted">Widget ayarlarından metin girin.</span>}
      </div>
    </div>
  );
}
