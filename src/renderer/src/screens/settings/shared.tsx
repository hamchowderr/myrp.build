import { AlertTriangle, CheckCircle2 } from "lucide-react";

export function StatusBadge({ value, isUnknown }: { value: string; isUnknown: boolean }) {
  if (isUnknown) {
    return (
      <div className="flex items-center gap-1 rounded-full bg-chart-3/10 px-2 py-0.5">
        <AlertTriangle className="size-2.5 text-chart-3/70" />
        <span className="font-mono text-[10px] text-chart-3/80">none</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 rounded-full bg-chart-2/10 px-2 py-0.5">
      <CheckCircle2 className="size-2.5 text-chart-2/70" />
      <span className="font-mono text-[10px] text-chart-2">{value}</span>
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-8 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {description && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="pb-3 pt-1">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">
        {title}
      </h3>
      {description && <p className="mt-1 text-[11px] text-muted-foreground">{description}</p>}
    </div>
  );
}
